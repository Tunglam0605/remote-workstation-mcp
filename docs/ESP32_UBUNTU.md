# ESP32 / ESP-IDF on Ubuntu

RWMCP v0.64 treats ESP32 work as a typed project workflow instead of a sequence of shell commands. The project profile owns the intended ESP-IDF installation, build directory and stable USB identity; runtime tools resolve those settings on every operation and fail closed when they are ambiguous.

## One-time project profile

Store project-specific defaults in `.rwmcp/project.yaml`. Prefer a stable serial identity over a Linux `/dev/ttyACM*` path because tty numbers may change after reconnects.

```yaml
version: 1
id: my-esp32-project
kind: esp-idf
firmware:
  buildProvider: esp-idf
  buildDir: build-linux
  espIdfPath: /home/user/esp/esp-idf
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

The same fields can be created through `engineering_profile_init`; both firmware and monitor selectors are typed. Use `hardware_list` first when the stable device identity is not known.

## Recommended workflow

1. Call `engineering_project_inspect` to confirm the project is detected as ESP32 / ESP-IDF and to inspect attached hardware.
2. Call `esp32_preflight` with only `workspace` and `projectPath` when a project profile already exists. Explicit arguments are overrides, not required repetition.
3. Require `readyForBuild=true` before build. Require `readyForFlash=true` before any hardware mutation.
4. Use `engineering_workflow_plan` for `firmware.build` or `firmware.build_flash_monitor_expect` to inspect the exact typed steps before execution.
5. Use `engineering_workflow_run` to execute the approved workflow under the normal Work Session, policy and resource-lease boundaries.

For low-level integration, `firmware_build`, `firmware_flash_plan` and `firmware_flash` remain available. High-level workflows are preferred because they automatically reuse project profile defaults.

## What preflight verifies

`esp32_preflight` resolves the selected ESP-IDF root, reports SDK/build provenance, checks target support, resolves one explicit or stable serial device and inspects the selected build directory. When ESP-IDF `flasher_args.json` is present, preflight also fingerprints every flash image with SHA-256, validates its offset, keeps images inside the selected build directory and reports total image bytes/highest written address.

A missing or invalid flash image blocks `readyForFlash` but does not block `readyForBuild`, so rebuilding can regenerate stale artifacts. An invalid SDK/target blocks both.

## ESP-IDF activation on Ubuntu

RWMCP does not require the interactive shell to have ESP-IDF exported globally. It activates the selected SDK through the packaged `scripts/esp-idf-run.sh` helper for each typed operation. This isolates project toolchains and avoids accidentally inheriting another terminal's `IDF_PATH`.

When multiple ESP-IDF installations are discovered and neither the project profile nor owner configuration selects one, RWMCP fails closed instead of choosing an arbitrary installation.

## Safety boundary

ESP32 build and diagnostics do not grant hardware authority. Flashing still requires the normal hardware-mutation policy and holds the selected serial resource lease for the transaction.

The ESP32 surface intentionally does not expose arbitrary esptool flags, erase-flash, raw ROM commands, eFuse writes, Secure Boot key burning or flash-encryption key mutation. These operations need stronger lifecycle and recovery semantics before they belong in the typed production surface.

## Ubuntu troubleshooting

- If preflight reports no matching serial device, rerun `hardware_list` and update the stable selector rather than hard-coding the current tty path.
- If existing build metadata names a different ESP-IDF root from the project profile, rebuild/reconfigure with the intended SDK before flashing.
- If flash images are missing, run the typed firmware build first; do not bypass preflight with raw esptool.
- If the device is discovered but cannot be opened, fix the local Linux serial-device permission/udev configuration as an owner operation; do not weaken RWMCP policy.
