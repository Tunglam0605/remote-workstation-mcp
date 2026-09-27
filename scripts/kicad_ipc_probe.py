#!/usr/bin/env python3
import importlib.util
import json
import os
import sys

result = {
    "schemaVersion": 1,
    "packageAvailable": importlib.util.find_spec("kipy") is not None,
    "connected": False,
    "socketConfigured": bool(os.environ.get("KICAD_API_SOCKET")),
    "tokenConfigured": bool(os.environ.get("KICAD_API_TOKEN")),
}

if not result["packageAvailable"]:
    result["reason"] = "kicad-python (kipy) is not installed in the selected Python environment."
    print(json.dumps(result, separators=(",", ":")))
    sys.exit(0)

try:
    from kipy import KiCad

    client = KiCad(timeout_ms=1000)
    try:
        version = client.get_version()
        full_version = getattr(version, "full_version", None) or str(version)
        result["connected"] = True
        result["kicadVersion"] = str(full_version)[:160]
        try:
            board = client.get_board()
            result["boardOpen"] = board is not None
            if board is not None:
                result["boardName"] = str(getattr(board, "name", ""))[:512]
        except Exception as board_error:
            result["boardOpen"] = False
            result["boardProbeError"] = str(board_error)[:512]
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()
except Exception as error:
    result["reason"] = str(error)[:1024]

print(json.dumps(result, separators=(",", ":")))
