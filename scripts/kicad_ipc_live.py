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
from kipy.geometry import Vector2, Angle


def fingerprint(board):
    text = board.get_as_string()
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), text


def ref_of(fp):
    try:
        return str(fp.reference_field.text.value)
    except Exception:
        return ""


def uid_of(fp):
    try:
        return str(fp.id.value)
    except Exception:
        return ""


def pose(fp):
    return {
        "xMm": fp.position.x / 1_000_000.0,
        "yMm": fp.position.y / 1_000_000.0,
        "rotationDeg": float(fp.orientation.degrees),
    }


def attributes_state(fp):
    attrs = fp.attributes
    return {
        "excludeFromBom": bool(attrs.exclude_from_bill_of_materials),
        "excludeFromPosFiles": bool(attrs.exclude_from_position_files),
        "doNotPopulate": bool(attrs.do_not_populate),
        "notInSchematic": bool(attrs.not_in_schematic),
    }


def footprint_state(fp):
    result = {
        **pose(fp),
        "locked": bool(fp.locked),
        "attributes": attributes_state(fp),
    }
    try:
        result["value"] = str(fp.value_field.text.value)
    except Exception:
        result["value"] = ""
    return result


def describe(fp):
    result = {
        "uuid": uid_of(fp),
        "reference": ref_of(fp),
        **footprint_state(fp),
        "layer": int(fp.layer),
    }
    try:
        result["value"] = str(fp.value_field.text.value)
    except Exception:
        pass
    return result


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

    # KiCad 9/10 may expose only a basename. In that bounded case, resolve
    # against the explicitly authorized board directory rather than cwd.
    if value.name == str(value):
        return (wanted.parent / value).resolve()

    raise RuntimeError("KICAD_IPC_BOARD_PATH_UNAVAILABLE: active board path cannot be resolved safely.")


def ensure_expected_board(board, expected):
    actual = resolve_board_path(board, expected)
    wanted = Path(expected).resolve()
    if os.path.normcase(str(actual)) != os.path.normcase(str(wanted)):
        raise RuntimeError("KICAD_IPC_BOARD_MISMATCH: active board does not match the authorized project board.")
    return actual


def find_one(board, uuid_value, reference):
    matches = []
    for fp in board.get_footprints():
        if uuid_value and uid_of(fp).lower() != uuid_value.lower():
            continue
        if reference and ref_of(fp).lower() != reference.lower():
            continue
        matches.append(fp)
    if len(matches) != 1:
        raise RuntimeError(f"KICAD_IPC_SELECTOR_MATCH: expected exactly one footprint, matched {len(matches)}.")
    return matches[0]


def drc_counts(cli_path, board_text, board_path):
    directory = str(board_path.parent)
    with tempfile.TemporaryDirectory(prefix=".rwmcp-ipc-drc-", dir=directory) as temp_dir:
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


def apply_pose(board, fp, x_mm, y_mm, rotation_deg, message):
    commit = board.begin_commit()
    try:
        position = Vector2()
        position.x = round(x_mm * 1_000_000)
        position.y = round(y_mm * 1_000_000)
        fp.position = position
        if rotation_deg is not None:
            angle = Angle()
            angle.degrees = float(rotation_deg)
            fp.orientation = angle
        board.update_items(fp)
        board.push_commit(commit, message)
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def apply_update(board, fp, update, message):
    commit = board.begin_commit()
    try:
        if "value" in update:
            value = str(update["value"])
            if len(value) > 512 or any(ord(ch) < 32 for ch in value):
                raise RuntimeError("KICAD_IPC_UPDATE_VALUE_INVALID")
            field = fp.value_field
            text_item = field.text
            text_item.value = value
            field.text = text_item
            fp.value_field = field
        if "locked" in update:
            fp.locked = bool(update["locked"])
        attrs = fp.attributes
        if "excludeFromBom" in update:
            attrs.exclude_from_bill_of_materials = bool(update["excludeFromBom"])
        if "excludeFromPosFiles" in update:
            attrs.exclude_from_position_files = bool(update["excludeFromPosFiles"])
        if "doNotPopulate" in update:
            attrs.do_not_populate = bool(update["doNotPopulate"])
        if "notInSchematic" in update:
            attrs.not_in_schematic = bool(update["notInSchematic"])
        board.update_items(fp)
        board.push_commit(commit, message)
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def set_pose(fp, x_mm, y_mm, rotation_deg):
    position = Vector2()
    position.x = round(float(x_mm) * 1_000_000)
    position.y = round(float(y_mm) * 1_000_000)
    fp.position = position
    if rotation_deg is not None:
        angle = Angle()
        angle.degrees = float(rotation_deg)
        fp.orientation = angle


def apply_batch_pose(board, entries, message):
    commit = board.begin_commit()
    try:
        items = []
        for fp, placement in entries:
            set_pose(fp, placement["xMm"], placement["yMm"], placement.get("rotationDeg"))
            items.append(fp)
        board.update_items(items)
        board.push_commit(commit, message)
    except Exception:
        try:
            board.drop_commit(commit)
        except Exception:
            pass
        raise


def has_regression(baseline, post):
    return (
        post["activeErrors"] > baseline["activeErrors"]
        or post["unconnected"] > baseline["unconnected"]
        or post["schematicParity"] > baseline["schematicParity"]
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["inspect", "move", "update", "batch-place"], required=True)
    parser.add_argument("--board-path", required=True)
    parser.add_argument("--kicad-cli")
    parser.add_argument("--expected-sha")
    parser.add_argument("--uuid")
    parser.add_argument("--reference")
    parser.add_argument("--x-mm", type=float)
    parser.add_argument("--y-mm", type=float)
    parser.add_argument("--rotation-deg", type=float)
    parser.add_argument("--max-items", type=int, default=500)
    parser.add_argument("--update-b64")
    parser.add_argument("--placements-b64")
    args = parser.parse_args()

    client = KiCad(timeout_ms=1500)
    board = client.get_board()
    if board is None:
        raise RuntimeError("KICAD_IPC_NO_BOARD: no PCB is open in KiCad.")
    board_path = ensure_expected_board(board, args.board_path)
    before_sha, before_text = fingerprint(board)

    if args.action == "inspect":
        fps = list(board.get_footprints())
        bounded = [describe(fp) for fp in fps[:max(1, min(args.max_items, 2000))]]
        print(json.dumps({
            "state": "ready",
            "boardPath": str(board_path),
            "boardSha256": before_sha,
            "footprintCount": len(fps),
            "footprints": bounded,
            "truncated": len(fps) > len(bounded),
        }, separators=(",", ":")))
        return

    if not args.expected_sha or args.expected_sha.lower() != before_sha.lower():
        raise RuntimeError("KICAD_IPC_CONFLICT: live board fingerprint changed.")
    if args.action == "update":
        if not args.kicad_cli or not args.update_b64:
            raise RuntimeError("KICAD_IPC_UPDATE_INPUT: kicad-cli and update payload are required.")
        if not args.uuid and not args.reference:
            raise RuntimeError("KICAD_IPC_UPDATE_INPUT: uuid or reference is required.")
        update = json.loads(base64.b64decode(args.update_b64, validate=True).decode("utf-8"))
        if not isinstance(update, dict) or not update:
            raise RuntimeError("KICAD_IPC_UPDATE_INPUT: update must be a non-empty object.")
        allowed = {"value", "locked", "excludeFromBom", "excludeFromPosFiles", "doNotPopulate", "notInSchematic"}
        if any(key not in allowed for key in update):
            raise RuntimeError("KICAD_IPC_UPDATE_INPUT: unsupported update field.")
        target = find_one(board, args.uuid, args.reference)
        original = footprint_state(target)
        baseline = drc_counts(args.kicad_cli, before_text, board_path)
        apply_update(board, target, update, "RWMCP: update footprint")
        rollback_update = {
            "value": original.get("value", ""),
            "locked": original["locked"],
            **original["attributes"],
        }
        try:
            after_sha, after_text = fingerprint(board)
            post = drc_counts(args.kicad_cli, after_text, board_path)
        except Exception as validation_error:
            current = find_one(board, args.uuid, args.reference)
            apply_update(board, current, rollback_update, "RWMCP: rollback failed footprint update")
            raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
        if has_regression(baseline, post):
            current = find_one(board, args.uuid, args.reference)
            apply_update(board, current, rollback_update, "RWMCP: rollback rejected footprint update")
            rollback_sha, _ = fingerprint(board)
            print(json.dumps({
                "state": "rejected",
                "boardPath": str(board_path),
                "beforeSha256": before_sha,
                "candidateSha256": after_sha,
                "rollbackSha256": rollback_sha,
                "original": original,
                "requested": update,
                "acceptance": {"baseline": baseline, "post": post, "passed": False},
                "saved": False,
            }, separators=(",", ":")))
            return
        current = find_one(board, args.uuid, args.reference)
        print(json.dumps({
            "state": "committed-live",
            "boardPath": str(board_path),
            "beforeSha256": before_sha,
            "afterSha256": after_sha,
            "original": original,
            "current": footprint_state(current),
            "acceptance": {"baseline": baseline, "post": post, "passed": True},
            "saved": False,
            "undoStep": True,
        }, separators=(",", ":")))
        return

    if args.action == "batch-place":
        if not args.kicad_cli or not args.placements_b64:
            raise RuntimeError("KICAD_IPC_BATCH_INPUT: kicad-cli and placement payload are required.")
        placements = json.loads(base64.b64decode(args.placements_b64, validate=True).decode("utf-8"))
        if not isinstance(placements, list) or not (1 <= len(placements) <= 32):
            raise RuntimeError("KICAD_IPC_BATCH_INPUT: placements must contain 1..32 entries.")
        entries = []
        originals = []
        seen = set()
        for placement in placements:
            if not isinstance(placement, dict):
                raise RuntimeError("KICAD_IPC_BATCH_INPUT: each placement must be an object.")
            uuid_value = placement.get("uuid")
            reference = placement.get("reference")
            if not uuid_value and not reference:
                raise RuntimeError("KICAD_IPC_BATCH_INPUT: every placement requires uuid or reference.")
            for key in ["xMm", "yMm"]:
                value = placement.get(key)
                if not isinstance(value, (int, float)) or not (-100000 <= float(value) <= 100000):
                    raise RuntimeError("KICAD_IPC_BATCH_INPUT: placement coordinates are invalid.")
            rotation = placement.get("rotationDeg")
            if rotation is not None and (not isinstance(rotation, (int, float)) or not (-100000 <= float(rotation) <= 100000)):
                raise RuntimeError("KICAD_IPC_BATCH_INPUT: placement rotation is invalid.")
            fp = find_one(board, uuid_value, reference)
            identity = uid_of(fp).lower()
            if identity in seen:
                raise RuntimeError("KICAD_IPC_BATCH_INPUT: duplicate footprint target.")
            seen.add(identity)
            if bool(fp.locked):
                raise RuntimeError("KICAD_IPC_LOCKED: footprint is locked.")
            entries.append((fp, placement))
            originals.append({
                "uuid": uid_of(fp),
                "reference": ref_of(fp),
                **pose(fp),
            })
        baseline = drc_counts(args.kicad_cli, before_text, board_path)
        apply_batch_pose(board, entries, "RWMCP: batch place footprints")
        rollback_entries = []
        for original in originals:
            current = find_one(board, original["uuid"], original["reference"])
            rollback_entries.append((current, original))
        try:
            after_sha, after_text = fingerprint(board)
            post = drc_counts(args.kicad_cli, after_text, board_path)
        except Exception as validation_error:
            apply_batch_pose(board, rollback_entries, "RWMCP: rollback failed batch placement")
            raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
        if has_regression(baseline, post):
            rollback_entries = []
            for original in originals:
                current = find_one(board, original["uuid"], original["reference"])
                rollback_entries.append((current, original))
            apply_batch_pose(board, rollback_entries, "RWMCP: rollback rejected batch placement")
            rollback_sha, _ = fingerprint(board)
            print(json.dumps({
                "state": "rejected",
                "boardPath": str(board_path),
                "beforeSha256": before_sha,
                "candidateSha256": after_sha,
                "rollbackSha256": rollback_sha,
                "originals": originals,
                "acceptance": {"baseline": baseline, "post": post, "passed": False},
                "saved": False,
            }, separators=(",", ":")))
            return
        current_items = []
        for original in originals:
            current_items.append(describe(find_one(board, original["uuid"], original["reference"])))
        print(json.dumps({
            "state": "committed-live",
            "boardPath": str(board_path),
            "beforeSha256": before_sha,
            "afterSha256": after_sha,
            "originals": originals,
            "current": current_items,
            "acceptance": {"baseline": baseline, "post": post, "passed": True},
            "saved": False,
            "undoStep": True,
            "itemCount": len(current_items),
        }, separators=(",", ":")))
        return

    if args.x_mm is None or args.y_mm is None:
        raise RuntimeError("KICAD_IPC_MOVE_INPUT: x/y are required.")
    if not args.uuid and not args.reference:
        raise RuntimeError("KICAD_IPC_MOVE_INPUT: uuid or reference is required.")
    if not args.kicad_cli:
        raise RuntimeError("KICAD_IPC_MOVE_INPUT: kicad-cli path is required.")

    target = find_one(board, args.uuid, args.reference)
    if bool(target.locked):
        raise RuntimeError("KICAD_IPC_LOCKED: footprint is locked.")
    original = pose(target)
    baseline = drc_counts(args.kicad_cli, before_text, board_path)

    apply_pose(board, target, args.x_mm, args.y_mm, args.rotation_deg, "RWMCP: move footprint")
    try:
        after_sha, after_text = fingerprint(board)
        post = drc_counts(args.kicad_cli, after_text, board_path)
    except Exception as validation_error:
        current = find_one(board, args.uuid, args.reference)
        apply_pose(board, current, original["xMm"], original["yMm"], original["rotationDeg"], "RWMCP: rollback failed validation")
        raise RuntimeError("KICAD_IPC_ACCEPTANCE_ERROR_ROLLED_BACK: " + str(validation_error))
    regressed = (
        post["activeErrors"] > baseline["activeErrors"]
        or post["unconnected"] > baseline["unconnected"]
        or post["schematicParity"] > baseline["schematicParity"]
    )

    if regressed:
        current = find_one(board, args.uuid, args.reference)
        apply_pose(board, current, original["xMm"], original["yMm"], original["rotationDeg"], "RWMCP: rollback rejected footprint move")
        rollback_sha, _ = fingerprint(board)
        print(json.dumps({
            "state": "rejected",
            "boardPath": str(board_path),
            "beforeSha256": before_sha,
            "candidateSha256": after_sha,
            "rollbackSha256": rollback_sha,
            "original": original,
            "requested": {"xMm": args.x_mm, "yMm": args.y_mm, "rotationDeg": args.rotation_deg},
            "acceptance": {"baseline": baseline, "post": post, "passed": False},
            "saved": False,
        }, separators=(",", ":")))
        return

    final_target = find_one(board, args.uuid, args.reference)
    print(json.dumps({
        "state": "committed-live",
        "boardPath": str(board_path),
        "beforeSha256": before_sha,
        "afterSha256": after_sha,
        "original": original,
        "current": pose(final_target),
        "acceptance": {"baseline": baseline, "post": post, "passed": True},
        "saved": False,
        "undoStep": True,
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "error", "error": str(error)[:2048]}, separators=(",", ":")))
        sys.exit(2)
