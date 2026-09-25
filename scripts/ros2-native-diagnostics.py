#!/usr/bin/env python3
import argparse
import json
import math
import os
import re
import statistics
import sys
import time
from collections import deque

SCHEMA_VERSION = 1
ROS_NAME = re.compile(r"^/[A-Za-z0-9_/]+$")
TF_FRAME = re.compile(r"^[A-Za-z0-9_./-]+$")


def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    raise SystemExit(code)


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def load_ros(require_tf=False):
    try:
        import rclpy
        import rclpy.qos as qosmod
        from rclpy.serialization import serialize_message
        from rosidl_runtime_py.utilities import get_message
        tf = None
        if require_tf:
            import tf2_ros
            from rclpy.time import Time
            tf = (tf2_ros, Time)
        return rclpy, qosmod, serialize_message, get_message, tf
    except Exception as exc:
        emit({
            "ok": False,
            "schemaVersion": SCHEMA_VERSION,
            "errorCode": "ROS_IMPORT_UNAVAILABLE",
            "error": f"{type(exc).__name__}: {exc}"[:512],
        }, 69)


def validate_topic(value):
    if not ROS_NAME.fullmatch(value) or "//" in value or len(value) > 256:
        emit({"ok": False, "schemaVersion": SCHEMA_VERSION, "errorCode": "INVALID_TOPIC"}, 64)


def validate_frame(value):
    value = value.lstrip("/")
    if not value or len(value) > 256 or not TF_FRAME.fullmatch(value) or ".." in value:
        emit({"ok": False, "schemaVersion": SCHEMA_VERSION, "errorCode": "INVALID_FRAME"}, 64)
    return value


def discover_type(node, topic, rclpy, deadline):
    while time.monotonic() < deadline:
        matches = dict(node.get_topic_names_and_types()).get(topic, [])
        unique = sorted(set(matches))
        if len(unique) == 1:
            return unique[0]
        if len(unique) > 1:
            emit({
                "ok": False,
                "schemaVersion": SCHEMA_VERSION,
                "errorCode": "AMBIGUOUS_TOPIC_TYPE",
                "types": unique[:16],
            }, 65)
        rclpy.spin_once(node, timeout_sec=0.05)
    emit({"ok": False, "schemaVersion": SCHEMA_VERSION, "errorCode": "TOPIC_NOT_DISCOVERED"}, 66)


def qos_for_topic(node, topic, qosmod, depth):
    Reliability = getattr(qosmod, "ReliabilityPolicy", None) or getattr(qosmod, "QoSReliabilityPolicy")
    Durability = getattr(qosmod, "DurabilityPolicy", None) or getattr(qosmod, "QoSDurabilityPolicy")
    infos = list(node.get_publishers_info_by_topic(topic))
    reliability = Reliability.RELIABLE
    if any(info.qos_profile.reliability == Reliability.BEST_EFFORT for info in infos):
        reliability = Reliability.BEST_EFFORT
    profile = qosmod.QoSProfile(
        depth=max(1, min(int(depth), 10000)),
        reliability=reliability,
        durability=Durability.VOLATILE,
    )
    return profile, {
        "publisherCount": len(infos),
        "reliability": "best_effort" if reliability == Reliability.BEST_EFFORT else "reliable",
        "durability": "volatile",
    }


def topic_sample(args, bandwidth=False):
    validate_topic(args.topic)
    rclpy, qosmod, serialize_message, get_message, _ = load_ros(False)
    rclpy.init(args=None)
    node = rclpy.create_node(f"_rwmcp_diag_{os.getpid()}")
    timestamps = deque(maxlen=args.window)
    sizes = deque(maxlen=args.window)
    deadline = time.monotonic() + args.timeout_ms / 1000.0
    try:
        type_name = discover_type(node, args.topic, rclpy, deadline)
        try:
            message_type = get_message(type_name)
        except Exception as exc:
            emit({
                "ok": False,
                "schemaVersion": SCHEMA_VERSION,
                "errorCode": "MESSAGE_TYPE_UNAVAILABLE",
                "error": f"{type(exc).__name__}: {exc}"[:512],
            }, 67)
        qos, qos_meta = qos_for_topic(node, args.topic, qosmod, args.window)

        def callback(msg):
            timestamps.append(time.monotonic_ns())
            if bandwidth:
                try:
                    sizes.append(len(serialize_message(msg)))
                except Exception:
                    sizes.append(0)

        subscription = node.create_subscription(message_type, args.topic, callback, qos)
        del subscription
        while time.monotonic() < deadline and len(timestamps) < args.window:
            rclpy.spin_once(node, timeout_sec=min(0.05, max(0.0, deadline - time.monotonic())))

        if len(timestamps) < 2:
            emit({
                "ok": False,
                "schemaVersion": SCHEMA_VERSION,
                "errorCode": "INSUFFICIENT_SAMPLES",
                "samples": len(timestamps),
            }, 68)

        periods = [(timestamps[i] - timestamps[i - 1]) / 1e9 for i in range(1, len(timestamps))]
        elapsed = (timestamps[-1] - timestamps[0]) / 1e9
        if elapsed <= 0:
            emit({"ok": False, "schemaVersion": SCHEMA_VERSION, "errorCode": "INVALID_SAMPLE_CLOCK"}, 68)

        if bandwidth:
            valid_sizes = [value for value in sizes if value >= 0]
            total_bytes = sum(valid_sizes)
            sample = {
                "bytesPerSecond": total_bytes / elapsed,
                "messageCount": len(valid_sizes),
                "meanMessageBytes": statistics.fmean(valid_sizes) if valid_sizes else 0.0,
                "minMessageBytes": min(valid_sizes) if valid_sizes else 0,
                "maxMessageBytes": max(valid_sizes) if valid_sizes else 0,
                "raw": "",
            }
            action = "topic-bw"
        else:
            sample = {
                "averageHz": (len(timestamps) - 1) / elapsed,
                "minPeriodSeconds": min(periods),
                "maxPeriodSeconds": max(periods),
                "stdDevSeconds": statistics.pstdev(periods) if len(periods) > 1 else 0.0,
                "window": len(timestamps),
                "raw": "",
            }
            action = "topic-hz"

        emit({
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "provider": "rclpy-native",
            "action": action,
            "topic": args.topic,
            "messageType": type_name,
            "qos": qos_meta,
            "sample": sample,
        })
    finally:
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            rclpy.shutdown()
        except Exception:
            pass


def tf_lookup(args):
    source = validate_frame(args.source_frame)
    target = validate_frame(args.target_frame)
    if source == target:
        emit({"ok": False, "schemaVersion": SCHEMA_VERSION, "errorCode": "IDENTICAL_FRAMES"}, 64)
    rclpy, _, _, _, tf_bundle = load_ros(True)
    tf2_ros, Time = tf_bundle
    rclpy.init(args=None)
    node = rclpy.create_node(f"_rwmcp_tf_{os.getpid()}")
    buffer = tf2_ros.Buffer()
    listener = tf2_ros.TransformListener(buffer, node, spin_thread=False)
    del listener
    deadline = time.monotonic() + args.timeout_ms / 1000.0
    last_error = ""
    try:
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.05)
            try:
                transform = buffer.lookup_transform(target, source, Time())
                stamp = transform.header.stamp
                emit({
                    "ok": True,
                    "schemaVersion": SCHEMA_VERSION,
                    "provider": "rclpy-native",
                    "action": "tf-lookup",
                    "sourceFrame": source,
                    "targetFrame": target,
                    "transform": {
                        "translation": {
                            "x": transform.transform.translation.x,
                            "y": transform.transform.translation.y,
                            "z": transform.transform.translation.z,
                        },
                        "rotationQuaternion": {
                            "x": transform.transform.rotation.x,
                            "y": transform.transform.rotation.y,
                            "z": transform.transform.rotation.z,
                            "w": transform.transform.rotation.w,
                        },
                        "time": f"{stamp.sec}.{stamp.nanosec:09d}",
                    },
                })
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"[:512]
        emit({
            "ok": False,
            "schemaVersion": SCHEMA_VERSION,
            "errorCode": "TF_LOOKUP_TIMEOUT",
            "error": last_error,
        }, 68)
    finally:
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            rclpy.shutdown()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(add_help=True)
    sub = parser.add_subparsers(dest="action", required=True)

    probe = sub.add_parser("probe")
    probe.set_defaults(handler=lambda _args: (load_ros(False), emit({
        "ok": True, "schemaVersion": SCHEMA_VERSION, "provider": "rclpy-native", "action": "probe"
    })))

    for action in ("topic-hz", "topic-bw"):
        p = sub.add_parser(action)
        p.add_argument("--topic", required=True)
        p.add_argument("--timeout-ms", type=int, required=True, choices=range(1000, 20001))
        p.add_argument("--window", type=int, required=True, choices=range(2, 10001))
        p.set_defaults(handler=(lambda a, bw=(action == "topic-bw"): topic_sample(a, bw)))

    p = sub.add_parser("tf-lookup")
    p.add_argument("--source-frame", required=True)
    p.add_argument("--target-frame", required=True)
    p.add_argument("--timeout-ms", type=int, required=True, choices=range(1000, 20001))
    p.set_defaults(handler=tf_lookup)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
