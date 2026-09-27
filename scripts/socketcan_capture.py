#!/usr/bin/env python3
import argparse
import socket
import struct
import sys
import time

CAN_EFF_FLAG = 0x80000000
CAN_RTR_FLAG = 0x40000000
CAN_ERR_FLAG = 0x20000000
CAN_SFF_MASK = 0x000007FF
CAN_EFF_MASK = 0x1FFFFFFF
CAN_RAW_FILTER = 1
CAN_RAW_ERR_FILTER = 2
CAN_RAW_FD_FRAMES = 5
CAN_ERR_MASK = 0x1FFFFFFF

def parse_filter(value: str):
    parts = value.split(":")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("filter must be id:mask:extended")
    can_id = int(parts[0], 16)
    mask = int(parts[1], 16)
    extended = parts[2] == "1"
    limit = CAN_EFF_MASK if extended else CAN_SFF_MASK
    if can_id < 0 or mask < 0 or can_id > limit or mask > limit:
        raise argparse.ArgumentTypeError("filter id/mask out of range")
    raw_id = can_id | (CAN_EFF_FLAG if extended else 0)
    raw_mask = mask | CAN_EFF_FLAG
    return raw_id, raw_mask

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--interface", required=True)
parser.add_argument("--count", type=int, required=True)
parser.add_argument("--timeout-ms", type=int, required=True)
parser.add_argument("--filter", action="append", default=[])
parser.add_argument("--errors", action="store_true")
args = parser.parse_args()

if not (1 <= args.count <= 1000):
    raise SystemExit("count out of range")
if not (100 <= args.timeout_ms <= 30000):
    raise SystemExit("timeout out of range")
if len(args.filter) > 32:
    raise SystemExit("too many filters")
if not args.interface or len(args.interface) > 15 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-" for c in args.interface):
    raise SystemExit("invalid interface name")

sock = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
filters = [parse_filter(item) for item in args.filter]
if filters:
    sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FILTER, b"".join(struct.pack("=II", can_id, mask) for can_id, mask in filters))
if args.errors:
    sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_ERR_FILTER, struct.pack("=I", CAN_ERR_MASK))
try:
    sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
except OSError:
    pass
sock.bind((args.interface,))
sock.settimeout(args.timeout_ms / 1000.0)

received = 0
while received < args.count:
    try:
        frame = sock.recv(72)
    except socket.timeout:
        break
    now = time.time()
    if len(frame) == 16:
        can_id, length, _pad, _res0, _len8_dlc, data = struct.unpack("=IBBBB8s", frame)
        payload = data[:length]
        is_fd = False
        fd_flags = 0
    elif len(frame) == 72:
        can_id, length, fd_flags, _res0, _res1, data = struct.unpack("=IBBBB64s", frame)
        payload = data[:length]
        is_fd = True
    else:
        continue
    is_eff = bool(can_id & CAN_EFF_FLAG)
    is_rtr = bool(can_id & CAN_RTR_FLAG)
    identifier = can_id & (CAN_EFF_MASK if is_eff else CAN_SFF_MASK)
    if can_id & CAN_ERR_FLAG:
        printable_id = can_id & 0xFFFFFFFF
        width = 8
    else:
        printable_id = identifier
        width = 8 if is_eff else 3
    id_text = f"{printable_id:0{width}X}"
    if is_rtr:
        body = f"R{length}"
        sep = "#"
    elif is_fd:
        body = f"{fd_flags:X}{payload.hex().upper()}"
        sep = "##"
    else:
        body = payload.hex().upper()
        sep = "#"
    print(f"({now:.6f}) {args.interface} {id_text}{sep}{body}", flush=True)
    received += 1

sock.close()
