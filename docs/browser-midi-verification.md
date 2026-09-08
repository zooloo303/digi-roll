# Verifying a browser release after the macOS SysEx regression

On 2026-09-08, Chrome 152.0.7977.83 on macOS timed out identifying Digitakt II,
Digitone II and Analog Four. The same browser with `--disable-features=MidiMacUmp`
identified all three and read checksum-valid A01 dumps: DT2 OS 1.15C/build 0071 (127,577 bytes), DN2 OS 1.10E/build 0050 (114,118 bytes), A4 OS 1.55B/build 0195 (14,843 bytes). Hardware writes were not tested. The affected release source lacks the framing correction
in [Chromium commit 5af1bee2](https://chromium.googlesource.com/chromium/src/+/5af1bee2ffd0d5234865b1848a52262b2081ecb2).
No fixed shipping release has been verified yet. Do not infer one from its major
version or the date of an upstream commit.

## Read-only hardware check

Serve this repository locally and install Playwright separately as dev tooling.
With the three named boxes connected, run:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs MIDI_REPORT=/tmp/midi-normal.json node scripts/check-browser-midi.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs MIDI_WORKAROUND=1 MIDI_REPORT=/tmp/midi-workaround.json node scripts/check-browser-midi.mjs
```

`LAB_URL` defaults to `http://127.0.0.1:8765/difflab.html`; `BROWSER_CHANNEL`
defaults to `chrome`. Each run uses a fresh temporary browser profile with MIDI
permission granted. The script identifies recognized connected boxes, reads A01
with the correct device-specific request, validates checksum/count via fetchDump,
and reports browser version, firmware, returned slot and byte count. It never
writes, plays notes or changes patterns. No recognized devices, or any failed
identity/read, causes a nonzero exit. Check that the report includes every box
claimed as tested; absent hardware is not a pass for that model.

Also exercise Connect and capture in the actual lab, Connect in the console,
and Import in the piano roll. Verify the help appears on identity timeouts and
clears after successful retry. Verify the separate launcher profile after a full
quit/relaunch. Normal Chrome need not be closed to use the separate profile.

## Separate manual write check

Read success alone is not write validation. Neil must use an explicitly selected
scratch project and a firmware build already allowed by digi-roll. Use the normal
write flow with its backup and byte comparison, then confirm the result on the
box. Do not widen firmware allowlists to get this test to run. Record untested
models and builds explicitly. The read-only script never performs this step.

Once the candidate release passes, update midi-help.html with the exact tested
release, OS, devices and scope; update the advisory browser match if needed.
Remove the launcher recommendation only after a normal launch works without the
switch. Keep existing firmware gates and SysEx encoding unchanged.
