#!/usr/bin/env python3
import argparse
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


def describe(fp):
    result = {
        "uuid": uid_of(fp),
        "reference": ref_of(fp),
        **pose(fp),
        "locked": bool(fp.locked),
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["inspect", "move"], required=True)
    parser.add_argument("--board-path", required=True)
    parser.add_argument("--kicad-cli")
    parser.add_argument("--expected-sha")
    parser.add_argument("--uuid")
    parser.add_argument("--reference")
    parser.add_argument("--x-mm", type=float)
    parser.add_argument("--y-mm", type=float)
    parser.add_argument("--rotation-deg", type=float)
    parser.add_argument("--max-items", type=int, default=500)
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
