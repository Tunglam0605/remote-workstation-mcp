#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from kipy import KiCad
from kipy.board_types import Track, ArcTrack, Via
from kipy.geometry import Vector2
from kipy.proto.board import board_types_pb2


def fingerprint(board):
    text = board.get_as_string()
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), text


def uid_of(item):
    try:
        return str(item.id.value)
    except Exception:
        return ""


def point(v):
    return {"xMm": v.x / 1_000_000.0, "yMm": v.y / 1_000_000.0}


def vec(x_mm, y_mm):
    return Vector2.from_xy(round(float(x_mm) * 1_000_000), round(float(y_mm) * 1_000_000))


def resolve_board_path(board, expected):
    value = Path(str(board.name))
    wanted = Path(expected).resolve()
    if value.is_absolute():
        return value.resolve()
    project_path = ""
    try:
        project_path = str(board.document.project.path)
    except Exception:
        try:
            project_path = str(board._doc.project.path)
        except Exception:
            project_path = ""
    if project_path:
        return (Path(project_path) / value).resolve()
    if value.name == str(value):
        return (wanted.parent / value).resolve()
    raise RuntimeError("KICAD_IPC_BOARD_PATH_UNAVAILABLE: active board path cannot be resolved safely.")


def ensure_expected_board(board, expected):
    actual = resolve_board_path(board, expected)
    wanted = Path(expected).resolve()
    if os.path.normcase(str(actual)) != os.path.normcase(str(wanted)):
        raise RuntimeError("KICAD_IPC_BOARD_MISMATCH: active board does not match the authorized project board.")
    return actual


def net_name(net):
    try:
        return str(net.name)
    except Exception:
        return ""


def find_net(board, name):
    matches = [net for net in board.get_nets() if net_name(net) == name]
    if len(matches) != 1:
        raise RuntimeError(f"KICAD_IPC_NET_MATCH: expected exactly one net named {name!r}, matched {len(matches)}.")
    return matches[0]


def layer_id(board, name):
    if not isinstance(name, str) or not name:
        raise RuntimeError("KICAD_IPC_LAYER_INVALID: layer name is required.")
    if name not in {"F.Cu", "B.Cu"} and not (name.startswith("In") and name.endswith(".Cu") and name[2:-3].isdigit()):
        raise RuntimeError("KICAD_IPC_LAYER_INVALID: only copper layers are accepted.")
    value = board.get_layer_by_name(name)
    if int(value) == int(board_types_pb2.BoardLayer.BL_UNDEFINED):
        raise RuntimeError(f"KICAD_IPC_LAYER_INVALID: copper layer {name!r} is not enabled on this board.")
    return value


def drc_counts(cli_path, board_text, board_path):
    directory = str(board_path.parent)
    with tempfile.TemporaryDirectory(prefix=".rwmcp-ipc-routing-drc-", dir=directory) as temp_dir:
        temp_dir = Path(temp_dir)
        board_file = temp_dir / "snapshot.kicad_pcb"
        report_file = temp_dir / "drc.json"
        board_file.write_text(board_text, encoding="utf-8")
        for suffix in [".kicad_pro", ".kicad_dru"]:
            source = board_path.with_suffix(suffix)
            if source.exists():
                (temp_dir / ("snapshot" + suffix)).write_bytes(source.read_bytes())
        result = subprocess.run(
            [cli_path, "pcb", "drc", "--format", "json", "--severity-all", "--output", str(report_file), str(board_file)],
            cwd=directory,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            check=False,
        )
        if not report_file.exists():
            raise RuntimeError("KICAD_IPC_DRC_FAILED: " + (result.stderr or result.stdout)[-1024:])
        report = json.loads(report_file.read_text(encoding="utf-8"))

        def active(items):
            return [item for item in (items or []) if not item.get("excluded", False)]

        violations = active(report.get("violations", []))
        unconnected = active(report.get("unconnected_items", []))
        parity = active(report.get("schematic_parity", []))
        errors = sum(1 for item in violations + unconnected + parity if str(item.get("severity", "")).lower() == "error")
        return {
            "activeErrors": errors,
            "unconnected": len(unconnected),
            "schematicParity": len(parity),
        }


def has_regression(baseline, post):
    return (
        post["activeErrors"] > baseline["activeErrors"]
        or post["unconnected"] > baseline["unconnected"]
        or post["schematicParity"] > baseline["schematicParity"]
    )


def commit_create(board, item, message):
    commit = board.begin_commit()
    try:
        created = board.create_items(item)
        if len(created) != 1:
            raise RuntimeError("KICAD_IPC_CREATE_RESULT: KiCad did not create exactly one routing item.")
        board.push_commit(commit, message)
        return created[0]
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def commit_update(board, item, message):
    commit = board.begin_commit()
    try:
        updated = board.update_items(item)
        if len(updated) != 1:
            raise RuntimeError("KICAD_IPC_UPDATE_RESULT: KiCad did not update exactly one routing item.")
        board.push_commit(commit, message)
        return updated[0]
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def commit_remove(board, item, message):
    commit = board.begin_commit()
    try:
        board.remove_items(item)
        board.push_commit(commit, message)
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def track_state(board, item):
    return {
        "kind": "arc" if isinstance(item, ArcTrack) else "track",
        "uuid": uid_of(item),
        "net": net_name(item.net),
        "layer": board.get_layer_name(item.layer),
        "start": point(item.start),
        "end": point(item.end),
        "widthMm": item.width / 1_000_000.0,
        "locked": bool(item.locked),
    }


def via_state(item):
    return {
        "kind": "via",
        "uuid": uid_of(item),
        "net": net_name(item.net),
        "position": point(item.position),
        "diameterMm": item.diameter / 1_000_000.0,
        "drillMm": item.drill_diameter / 1_000_000.0,
        "viaType": int(item.type),
        "locked": bool(item.locked),
    }


def zone_state(board, item):
    net = ""
    try:
        if item.net is not None:
            net = net_name(item.net)
    except Exception:
        pass
    return {
        "uuid": uid_of(item),
        "name": str(item.name),
        "net": net,
        "layers": [board.get_layer_name(layer) for layer in item.layers],
        "locked": bool(item.locked),
        "filled": bool(item.filled),
        "ruleArea": bool(item.is_rule_area()),
    }


def find_track(board, uuid_value):
    matches = [item for item in board.get_tracks() if uid_of(item).lower() == uuid_value.lower()]
    if len(matches) != 1:
        raise RuntimeError(f"KICAD_IPC_ROUTING_SELECTOR_MATCH: expected one track, matched {len(matches)}.")
    if isinstance(matches[0], ArcTrack):
        raise RuntimeError("KICAD_IPC_ROUTING_UNSUPPORTED: arc-track mutation is not exposed in Phase 6.")
    return matches[0]


def find_via(board, uuid_value):
    matches = [item for item in board.get_vias() if uid_of(item).lower() == uuid_value.lower()]
    if len(matches) != 1:
        raise RuntimeError(f"KICAD_IPC_ROUTING_SELECTOR_MATCH: expected one via, matched {len(matches)}.")
    return matches[0]


def acceptance_create(board, created, before_sha, before_text, board_path, cli_path, original_kind):
    baseline = drc_counts(cli_path, before_text, board_path)
    after_sha, after_text = fingerprint(board)
    try:
        post = drc_counts(cli_path, after_text, board_path)
    except Exception as validation_error:
        commit_remove(board, created, "RWMCP: rollback failed routing validation")
        raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
    if has_regression(baseline, post):
        commit_remove(board, created, "RWMCP: rollback rejected routing create")
        rollback_sha, _ = fingerprint(board)
        return {
            "state": "rejected",
            "beforeSha256": before_sha,
            "candidateSha256": after_sha,
            "rollbackSha256": rollback_sha,
            "kind": original_kind,
            "acceptance": {"baseline": baseline, "post": post, "passed": False},
            "saved": False,
        }
    return {
        "state": "committed-live",
        "beforeSha256": before_sha,
        "afterSha256": after_sha,
        "kind": original_kind,
        "acceptance": {"baseline": baseline, "post": post, "passed": True},
        "saved": False,
        "undoStep": True,
    }


def restore_track(board, item, original, message):
    item.net = find_net(board, original["net"])
    item.layer = layer_id(board, original["layer"])
    item.start = vec(original["start"]["xMm"], original["start"]["yMm"])
    item.end = vec(original["end"]["xMm"], original["end"]["yMm"])
    item.width = round(original["widthMm"] * 1_000_000)
    item.locked = original["locked"]
    return commit_update(board, item, message)


def restore_via(board, item, original, message):
    item.net = find_net(board, original["net"])
    item.position = vec(original["position"]["xMm"], original["position"]["yMm"])
    item.diameter = round(original["diameterMm"] * 1_000_000)
    item.drill_diameter = round(original["drillMm"] * 1_000_000)
    item.locked = original["locked"]
    return commit_update(board, item, message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["inspect", "track-add", "track-update", "via-add", "via-update", "zone-refill"], required=True)
    parser.add_argument("--board-path", required=True)
    parser.add_argument("--kicad-cli")
    parser.add_argument("--expected-sha")
    parser.add_argument("--payload-b64")
    parser.add_argument("--max-items", type=int, default=1000)
    args = parser.parse_args()

    client = KiCad(timeout_ms=1500)
    board = client.get_board()
    if board is None:
        raise RuntimeError("KICAD_IPC_NO_BOARD: no PCB is open in KiCad.")
    board_path = ensure_expected_board(board, args.board_path)
    before_sha, before_text = fingerprint(board)

    if args.action == "inspect":
        limit = max(1, min(args.max_items, 2000))
        tracks = list(board.get_tracks())
        vias = list(board.get_vias())
        zones = list(board.get_zones())
        nets = sorted({net_name(net) for net in board.get_nets() if net_name(net)})
        print(json.dumps({
            "state": "ready",
            "boardPath": str(board_path),
            "boardSha256": before_sha,
            "nets": nets[:2000],
            "trackCount": len(tracks),
            "viaCount": len(vias),
            "zoneCount": len(zones),
            "tracks": [track_state(board, item) for item in tracks[:limit]],
            "vias": [via_state(item) for item in vias[:limit]],
            "zones": [zone_state(board, item) for item in zones[:limit]],
            "truncated": len(tracks) > limit or len(vias) > limit or len(zones) > limit or len(nets) > 2000,
        }, separators=(",", ":")))
        return

    if not args.expected_sha or args.expected_sha.lower() != before_sha.lower():
        raise RuntimeError("KICAD_IPC_CONFLICT: live board fingerprint changed.")
    if not args.kicad_cli:
        raise RuntimeError("KICAD_IPC_ROUTING_INPUT: kicad-cli path is required.")
    if not args.payload_b64:
        raise RuntimeError("KICAD_IPC_ROUTING_INPUT: typed payload is required.")
    payload = json.loads(base64.b64decode(args.payload_b64, validate=True).decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("KICAD_IPC_ROUTING_INPUT: payload must be an object.")

    if args.action == "track-add":
        net = find_net(board, payload["netName"])
        layer = layer_id(board, payload["layerName"])
        start = payload["start"]
        end = payload["end"]
        width_mm = float(payload["widthMm"])
        if start == end:
            raise RuntimeError("KICAD_IPC_TRACK_INPUT: track endpoints must differ.")
        track = Track()
        track.net = net
        track.layer = layer
        track.start = vec(start["xMm"], start["yMm"])
        track.end = vec(end["xMm"], end["yMm"])
        track.width = round(width_mm * 1_000_000)
        track.locked = bool(payload.get("locked", False))
        created = commit_create(board, track, "RWMCP: add track segment")
        result = acceptance_create(board, created, before_sha, before_text, board_path, args.kicad_cli, "track")
        result["item"] = track_state(board, created) if result["state"] == "committed-live" else None
        result["boardPath"] = str(board_path)
        print(json.dumps(result, separators=(",", ":")))
        return

    if args.action == "via-add":
        net = find_net(board, payload["netName"])
        diameter_mm = float(payload["diameterMm"])
        drill_mm = float(payload["drillMm"])
        if drill_mm >= diameter_mm:
            raise RuntimeError("KICAD_IPC_VIA_INPUT: drill must be smaller than diameter.")
        via = Via()
        via.type = board_types_pb2.ViaType.VT_THROUGH
        via.net = net
        via.position = vec(payload["position"]["xMm"], payload["position"]["yMm"])
        via.diameter = round(diameter_mm * 1_000_000)
        via.drill_diameter = round(drill_mm * 1_000_000)
        via.locked = bool(payload.get("locked", False))
        created = commit_create(board, via, "RWMCP: add through via")
        result = acceptance_create(board, created, before_sha, before_text, board_path, args.kicad_cli, "via")
        result["item"] = via_state(created) if result["state"] == "committed-live" else None
        result["boardPath"] = str(board_path)
        print(json.dumps(result, separators=(",", ":")))
        return

    if args.action == "track-update":
        item = find_track(board, payload["uuid"])
        original = track_state(board, item)
        if not original["net"]:
            raise RuntimeError("KICAD_IPC_ROUTING_UNSUPPORTED: netless track mutation is not exposed in Phase 6.")
        if "netName" in payload:
            item.net = find_net(board, payload["netName"])
        if "layerName" in payload:
            item.layer = layer_id(board, payload["layerName"])
        if "start" in payload:
            item.start = vec(payload["start"]["xMm"], payload["start"]["yMm"])
        if "end" in payload:
            item.end = vec(payload["end"]["xMm"], payload["end"]["yMm"])
        if "widthMm" in payload:
            item.width = round(float(payload["widthMm"]) * 1_000_000)
        if item.start.x == item.end.x and item.start.y == item.end.y:
            raise RuntimeError("KICAD_IPC_TRACK_INPUT: track endpoints must differ.")
        if "locked" in payload:
            item.locked = bool(payload["locked"])
        baseline = drc_counts(args.kicad_cli, before_text, board_path)
        updated = commit_update(board, item, "RWMCP: update track segment")
        try:
            after_sha, after_text = fingerprint(board)
            post = drc_counts(args.kicad_cli, after_text, board_path)
        except Exception as validation_error:
            current = find_track(board, uid_of(updated))
            restore_track(board, current, original, "RWMCP: rollback failed track validation")
            raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
        if has_regression(baseline, post):
            current = find_track(board, uid_of(updated))
            restore_track(board, current, original, "RWMCP: rollback rejected track update")
            rollback_sha, _ = fingerprint(board)
            print(json.dumps({"state":"rejected","boardPath":str(board_path),"beforeSha256":before_sha,"candidateSha256":after_sha,"rollbackSha256":rollback_sha,"original":original,"acceptance":{"baseline":baseline,"post":post,"passed":False},"saved":False}, separators=(",", ":")))
            return
        print(json.dumps({"state":"committed-live","boardPath":str(board_path),"beforeSha256":before_sha,"afterSha256":after_sha,"original":original,"current":track_state(board, updated),"acceptance":{"baseline":baseline,"post":post,"passed":True},"saved":False,"undoStep":True}, separators=(",", ":")))
        return

    if args.action == "via-update":
        item = find_via(board, payload["uuid"])
        original = via_state(item)
        if not original["net"]:
            raise RuntimeError("KICAD_IPC_ROUTING_UNSUPPORTED: netless via mutation is not exposed in Phase 6.")
        if int(item.type) != int(board_types_pb2.ViaType.VT_THROUGH):
            raise RuntimeError("KICAD_IPC_ROUTING_UNSUPPORTED: only through-via mutation is exposed in Phase 6.")
        if "netName" in payload:
            item.net = find_net(board, payload["netName"])
        if "position" in payload:
            item.position = vec(payload["position"]["xMm"], payload["position"]["yMm"])
        if "diameterMm" in payload:
            item.diameter = round(float(payload["diameterMm"]) * 1_000_000)
        if "drillMm" in payload:
            item.drill_diameter = round(float(payload["drillMm"]) * 1_000_000)
        if item.drill_diameter >= item.diameter:
            raise RuntimeError("KICAD_IPC_VIA_INPUT: drill must be smaller than diameter.")
        if "locked" in payload:
            item.locked = bool(payload["locked"])
        baseline = drc_counts(args.kicad_cli, before_text, board_path)
        updated = commit_update(board, item, "RWMCP: update through via")
        try:
            after_sha, after_text = fingerprint(board)
            post = drc_counts(args.kicad_cli, after_text, board_path)
        except Exception as validation_error:
            current = find_via(board, uid_of(updated))
            restore_via(board, current, original, "RWMCP: rollback failed via validation")
            raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
        if has_regression(baseline, post):
            current = find_via(board, uid_of(updated))
            restore_via(board, current, original, "RWMCP: rollback rejected via update")
            rollback_sha, _ = fingerprint(board)
            print(json.dumps({"state":"rejected","boardPath":str(board_path),"beforeSha256":before_sha,"candidateSha256":after_sha,"rollbackSha256":rollback_sha,"original":original,"acceptance":{"baseline":baseline,"post":post,"passed":False},"saved":False}, separators=(",", ":")))
            return
        print(json.dumps({"state":"committed-live","boardPath":str(board_path),"beforeSha256":before_sha,"afterSha256":after_sha,"original":original,"current":via_state(updated),"acceptance":{"baseline":baseline,"post":post,"passed":True},"saved":False,"undoStep":True}, separators=(",", ":")))
        return

    if args.action == "zone-refill":
        zones = list(board.get_zones())
        if not zones:
            raise RuntimeError("KICAD_IPC_ZONE_REFILL_EMPTY: the board has no zones.")
        baseline = drc_counts(args.kicad_cli, before_text, board_path)
        board.refill_zones(block=True, max_poll_seconds=30.0, poll_interval_seconds=0.5)
        after_sha, after_text = fingerprint(board)
        post = drc_counts(args.kicad_cli, after_text, board_path)
        if has_regression(baseline, post):
            raise RuntimeError("KICAD_IPC_ZONE_REFILL_REGRESSION: zone refill changed DRC results; no automatic geometry rollback is available for KiCad 10 zone fill state.")
        print(json.dumps({
            "state":"committed-live",
            "boardPath":str(board_path),
            "beforeSha256":before_sha,
            "afterSha256":after_sha,
            "zoneCount":len(zones),
            "acceptance":{"baseline":baseline,"post":post,"passed":True},
            "saved":False,
            "undoStep":False
        }, separators=(",", ":")))
        return


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "error", "error": str(error)[:2048]}, separators=(",", ":")))
        sys.exit(2)
