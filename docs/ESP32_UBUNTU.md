# ESP32 / ESP-IDF on Ubuntu

RWMCP v0.65 extends the v0.64 typed ESP32 workflow with reproducible ESP-IDF environment provenance and bounded build-cache maintenance. The project profile owns the intended ESP-IDF installation, build directory, Python environment policy, expected compiler provenance and stable USB identity; runtime tools resolve and verify those settings on every operation and fail closed when they are ambiguous.

## One-time project profile

Store project-specific defaults in `.rwmcp/project.yaml`. Prefer a stable serial identity over a Linux `/dev/ttyACM*` path because tty numbers may change after reconnects.

```yaml
version: 1
id: my-esp32-project
kind: esp-idf
firmware:
  buildProvider: esp-idf
  buildDir: build-ready4
  espIdfPath: /home/user/esp/esp-idf
  espIdfEnvironment:
    pythonEnvPath: /home/user/.espressif/python_env/idf6.1_py3.11_env
    skipCheckSubmodules: true
    expectedPythonVersion: "3.11"
    expectedCompilerPath: /home/user/.espressif/tools/xtensa-esp-elf/esp-15.2.0_20250929/xtensa-esp-elf/bin/xtensa-esp32s3-elf-gcc
    expectedCompilerVersion: "15.2.0"
  flashProvider: esp-idf
  portSelector:
    serialNumber: YOUR_DEVICE_SERIAL
    vendorId: 303A
    productId: 1001
  monitor:
    selector:
      serialNumber: YOUR_DEVICE_SERIAL
      vendorId: 303A
      productId: 1001
    baudRate: 115200
    expectText: WiFi started
    expectTimeoutMs: 20000
```

The same profile can be created through the generic `profile` payload of `engineering_profile_init`. The ESP-IDF environment is deliberately a closed typed structure; there is no arbitrary environment-variable map. Use `hardware_list` first when the stable device identity is not known.

## Recommended workflow

1. Call `engineering_project_inspect` to confirm the project is detected as ESP32 / ESP-IDF and inspect attached hardware.
2. Call `engineering_workflow_plan` for `espidf.preflight`. This route is available through the existing generic workflow envelope even when a client has not refreshed its top-level `esp32_preflight` action catalog.
3. Run `espidf.preflight` and require `readyForBuild=true` before build. Require `readyForFlash=true` before any hardware mutation.
4. Use `firmware.build` or `firmware.build_flash_monitor_expect` through the same high-level workflow envelope.
5. Use `espidf.reconfigure` when the selected SDK/environment changes. Use `espidf.fullclean` only when a full CMake/build-cache reset is explicitly intended.

The direct `esp32_preflight`, `firmware_build`, `firmware_flash_plan` and `firmware_flash` tools remain available as low-level primitives. Profile-aware high-level workflows are preferred for repeatable project operation.

## What preflight verifies

Preflight resolves the selected ESP-IDF root, activates the configured Python environment, reports Python executable/version and effective `IDF_PATH`, records the bounded `IDF_SKIP_CHECK_SUBMODULES` policy, reads compiler provenance from `project_description.json`, and probes the recorded compiler version when available.

The readiness semantics are intentional:

- An active SDK/Python/environment-policy mismatch blocks both build and flash.
- A stale compiler path/version in an existing build blocks flash but still allows build/reconfigure so the build metadata can repair itself.
- A build directory that resolves through a symlink outside the selected project is rejected before maintenance, build or flash.
- A missing or invalid flash image blocks flash but does not block build.

When `flasher_args.json` is present, preflight fingerprints every flash image with SHA-256, validates its offset, keeps images inside the selected build directory and reports total image bytes/highest written address.

## Typed maintenance

`espidf.fullclean` and `espidf.reconfigure` are fixed workflows. The caller does not supply an arbitrary ESP-IDF action or shell command.

Both operations:

- use the configured project-local build directory,
- use the selected ESP-IDF root and typed Python/environment policy,
- hold the same `project-variant:esp-idf:...` build lease as firmware build,
- reject build-directory path traversal and symlink escape.

`fullclean` removes generated build state only through the official ESP-IDF action; it does not delete project source files. For production projects, prefer a disposable/new build directory when proving clean-build behavior instead of destroying a known-good build cache unnecessarily.

## ESP-IDF activation on Ubuntu

RWMCP does not require the interactive shell to have ESP-IDF exported globally. It activates the selected SDK through the packaged `scripts/esp-idf-run.sh` helper for each typed operation.

The helper accepts only RWMCP-owned control flags for the Python environment, submodule-check policy and provenance probe. It then sources the selected SDK's `export.sh` and invokes the SDK's `idf.py`. Windows has equivalent behavior through `scripts/esp-idf-run.ps1`.

When multiple ESP-IDF installations are discovered and neither the project profile nor owner configuration selects one, RWMCP fails closed instead of choosing an arbitrary installation.

## Safety boundary

ESP32 build, diagnostics, preflight and maintenance do not grant hardware authority. Flashing still requires the normal hardware-mutation policy and holds the selected serial resource lease for the transaction.

The ESP32 surface intentionally does not expose arbitrary environment maps, arbitrary esptool flags, erase-flash, raw ROM commands, eFuse writes, Secure Boot key burning or flash-encryption key mutation. These operations need stronger lifecycle and recovery semantics before they belong in the typed production surface.

## Ubuntu troubleshooting

- If preflight reports no matching serial device, rerun `hardware_list` and update the stable selector rather than hard-coding the current tty path.
- If the active Python environment or version differs from the profile, correct `firmware.espIdfEnvironment` or the installed ESP-IDF tools before building.
- If existing build metadata names a different ESP-IDF root or compiler from the project profile, run typed reconfigure/build with the intended SDK before flashing.
- If flash images are missing, run the typed firmware build first; do not bypass preflight with raw esptool.
- If the device is discovered but cannot be opened, fix the local Linux serial-device permission/udev configuration as an owner operation; do not weaken RWMCP policy.
