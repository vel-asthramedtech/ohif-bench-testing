# OHIF Benchmark (Playwright)

Measures two things for CT studies of different sizes (10 MB to 1 GB and beyond):

| Test file | What it measures | Output |
|---|---|---|
| `upload.spec.js` | Time and throughput to upload each scan folder to Orthanc (PACS) | `upload.csv`, `studies.json` |
| `bench.spec.js` | OHIF 2D first-render time and 3D/MPR visual-load time, cold and warm | `render.csv`, `render3d.csv`, `shots/*.png` |

Run upload first. It creates `studies.json`, which `bench.spec.js` reads. Both CSVs record the actual scan size, so results can be compared by size.

> **Windows / PowerShell notes**
> - Use `curl.exe`, not `curl` (in PowerShell `curl` is an alias for a different command).
> - Environment variables set with `$env:NAME=...` **stay set for the whole PowerShell session**. Clear them (section 5) before a new run, or old settings such as `FULL_LOAD` or `NETWORK` will silently change your results.
> - Don't create CSV files with `echo ... > file`. It writes UTF-16 and corrupts the data. The scripts create their own headers.

---

## 1. Prerequisites

- Node.js 18+
- Orthanc running with the DICOMweb plugin (this setup uses REST port `2000`)
- OHIF running and pointed at Orthanc's `/dicom-web` (default `http://localhost:3000`)
- DICOM scans in the `scans` folder

Check that both services are up:

```powershell
curl.exe http://localhost:2000/system
curl.exe -I http://localhost:3000
```

## 2. Install

```powershell
cd ohif-bench
npm init -y
npm i -D @playwright/test
npx playwright install chromium
```

## 3. Project layout

```
ohif-bench/
  playwright.config.js
  upload.spec.js
  bench.spec.js
  scans/
    250MB/   (any number of .dcm files, sub-folders allowed)
    500MB/
    1GB/
  studies.json      (created by upload.spec.js)
  upload.csv        (created by upload.spec.js)
  render.csv        (created by bench.spec.js)
  render3d.csv      (created by bench.spec.js)
  shots/            (3D screenshots, created by bench.spec.js)
```

Each folder under `scans/` is one scan and one test. The folder name is just a label (for example `250MB`). The real size is calculated from the files on disk. Folders are found automatically, so there is no list to edit. They are run in order of the size in their name.

Files with the extension `.dcm` or `.dicom`, or with no extension, are uploaded. Other files (like `.txt`) are ignored.

## 4. Clean results before every fresh session

```powershell
Remove-Item upload.csv, studies.json, render.csv, render3d.csv -ErrorAction SilentlyContinue
Remove-Item -Recurse shots -ErrorAction SilentlyContinue
```

**Delete old CSVs after updating the scripts.** The column layout changed, so rows from older versions would mix with the new ones.

Optionally clear old studies from Orthanc:

```powershell
# list study ids
curl.exe http://localhost:2000/studies

# delete one study
curl.exe -X DELETE http://localhost:2000/studies/<STUDY_ID>
```

## 5. Clear leftover environment variables

```powershell
# see what is currently set
Get-ChildItem Env: | Where-Object Name -match "FULL_LOAD|NETWORK|HEADED|MODE|RUNS|HP|VIEWPORTS|OHIF_URL|ORTHANC_URL|SCANS_DIR"

# clear everything the benchmark uses
Remove-Item Env:FULL_LOAD, Env:NETWORK, Env:HEADED, Env:MODE, Env:RUNS, Env:HP, Env:VIEWPORTS, Env:OHIF_URL, Env:ORTHANC_URL, Env:SCANS_DIR -ErrorAction SilentlyContinue
```

`bench.spec.js` prints the active settings at the start of every run:

```
[config] MODE=both RUNS=5 FULL_LOAD=false NETWORK=off HEADED=off HP=mprAnd3DVolumeViewport VIEWPORTS=4
```

Check this line first if results look odd.

---

## 6. Upload test (`upload.spec.js`)

For each folder in `scans/`, it uploads every DICOM file to Orthanc `RUNS` times and times each run. The study is deleted between runs and the last upload is kept so the render tests can open it. The study UID, instance count and size are saved in `studies.json`. Re-running a size replaces its entry, so there are no duplicates.

### Commands

```powershell
# all folders in scans/
npx playwright test upload.spec.js

# one folder only
npx playwright test upload.spec.js -g "upload 500MB"

# different Orthanc address, more runs
$env:ORTHANC_URL="http://localhost:8042"; $env:RUNS=5; npx playwright test upload.spec.js

# different scans folder
$env:SCANS_DIR="D:\ct-data"; npx playwright test upload.spec.js

# check what Orthanc holds afterwards
curl.exe http://localhost:2000/studies
```

### Environment options

| Variable | Default | Meaning |
|---|---|---|
| `ORTHANC_URL` | `http://localhost:2000` | Orthanc REST address |
| `RUNS` | `2` | Repetitions per folder |
| `SCANS_DIR` | `scans` | Folder holding the scan sub-folders |

### Output: `upload.csv`

| Column | Meaning |
|---|---|
| `timestamp`, `label`, `run` | When, which folder, which repetition |
| `files` | Number of DICOM files uploaded |
| `total_bytes`, `total_mb` | Actual size of the scan on disk |
| `seconds` | Wall-clock time, including reading files from disk |
| `post_seconds` | Time spent only in the upload requests |
| `mb_per_s`, `files_per_s` | Throughput |
| `avg_ms_per_file`, `median_ms_per_file`, `max_ms_per_file` | Per-file timing |
| `failed_files` | Files that failed to upload |
| `already_stored` | Files Orthanc already had |
| `orthanc_instances`, `orthanc_series`, `orthanc_disk_mb` | What Orthanc reports it stored |
| `study_uid` | The study created |
| `status` | `ok`, `failed_files: ...`, or `no_study_created` |

Cross-check: `orthanc_instances` should equal `files`. If it is lower, some uploads were dropped or merged.

### Notes

- A failed file is counted in `failed_files` and the run continues. It does not stop the test.
- Each folder should contain **one study**. If its files belong to several studies, the test warns and uses the largest one for the render tests.
- Large sizes take a while. The 1 GB case can take several minutes per run. The limit is 1 hour per folder.

---

## 7. Render test (`bench.spec.js`)

Opens each study listed in `studies.json` in OHIF in a fresh browser context (cold cache), measures, then reloads in the same context (warm cache) and measures again.

- **2D**: time to the first rendered image in stack view. Optionally scrolls through the series for a full load.
- **3D**: time until the 3D/MPR viewports visually show content and stop changing. It does not wait for a full download.

### Commands

```powershell
# 2D + 3D, 5 runs each (default)
npx playwright test bench.spec.js

# 2D only
$env:MODE="2d"; npx playwright test bench.spec.js

# 3D only, 3 runs, visible browser (best for realistic GPU timings)
$env:MODE="3d"; $env:RUNS=3; $env:HEADED=1; npx playwright test bench.spec.js

# one study, one run (quick check)
$env:RUNS=1; npx playwright test bench.spec.js -g "250MB run 1"

# 2D with full-series load (scrolls through every slice)
$env:MODE="2d"; $env:FULL_LOAD=1; npx playwright test bench.spec.js

# throttled network (fast4g or slow4g)
$env:NETWORK="fast4g"; npx playwright test bench.spec.js

# 3D-only layout
$env:MODE="3d"; $env:HP="only3D"; $env:VIEWPORTS=1; npx playwright test bench.spec.js

# debug a single test step by step
$env:HEADED=1; npx playwright test bench.spec.js -g "3D 250MB run 1" --debug
```

**After any of these, run the cleanup from section 5**, because the variables stay set.

### Environment options

| Variable | Default | Meaning |
|---|---|---|
| `OHIF_URL` | `http://localhost:3000` | OHIF base URL |
| `RUNS` | `5` | Repetitions per study |
| `MODE` | `both` | `both`, `2d` or `3d` |
| `HP` | `mprAnd3DVolumeViewport` | Hanging protocol id for 3D |
| `VIEWPORTS` | `4` | Number of viewports that must show content in 3D |
| `FULL_LOAD` | off | 2D only: scroll to the last slice and wait for network idle |
| `NETWORK` | off | `fast4g` or `slow4g` throttling |
| `HEADED` | off | Run with a visible browser |

### Built-in limits

| Limit | Value | What happens |
|---|---|---|
| Test timeout (cold + warm) | 20 min | Test fails |
| 2D first render, event wait | 20 s | Falls back to the canvas check |
| 2D first render, canvas wait | 60 s | Run recorded as `failed` |
| `FULL_LOAD` scrolling | 3 min | Stops, status `scroll_cap` |
| `FULL_LOAD` network idle wait | 60 s | Status `idle_timeout` |
| 3D visual wait | 120 s | Status `no_visual` or `never_stable` |

These constants are at the top of `bench.spec.js` if you need to change them.

### 3D layouts

| Layout | `HP` | `VIEWPORTS` |
|---|---|---|
| MPR + 3D | `mprAnd3DVolumeViewport` | 4 |
| 3D only | `only3D` | 1 |
| 3D four up | `fourUp` | 4 |

Hanging protocol ids differ between OHIF versions. If the id isn't recognized, OHIF shows the normal stack view and the CSV status reads `no_visual (viewports seen: 1, expected 4)`. Check your version's protocol list for the right id.

### Output: `render.csv` (2D)

```
timestamp, label, size_mb, instances, phase, run, network, headed,
first_frame_ms, last_frame_ms, first_render_ms, render_source, full_load_ms,
frames, heap_mb, status
```

- `label`, `size_mb`, `instances`: the scan, taken from `studies.json`
- `phase`: `cold` (empty cache) or `warm` (reload with cache)
- `network`, `headed`: the settings used for this row (`off`/`no` are the defaults)
- `first_frame_ms`, `last_frame_ms`: when the first and last image-frame responses arrived
- `first_render_ms`: first image painted
- `render_source`: `event` (Cornerstone event) or `canvas` (fallback, slightly less precise)
- `full_load_ms`: only filled when `FULL_LOAD=1`
- `status`: `ok`, `idle_timeout`, `scroll_cap`, or `failed: ...`

### Output: `render3d.csv` (3D)

```
timestamp, label, size_mb, instances, phase, run, hp, network, headed,
first_frame_ms, last_frame_ms, visual_first_ms, visual_ready_ms,
ready_after_last_frame_ms, viewports, frames, heap_mb, status
```

- `visual_first_ms`: first time all expected viewports show content
- `visual_ready_ms`: when the picture last changed before staying still for 1.5 s
- `last_frame_ms`: when the last image-frame response arrived
- `ready_after_last_frame_ms`: `visual_ready_ms − last_frame_ms`. A rough estimate of how long rendering took after the data arrived. If it is large and does not change with study size, the time is mostly rendering (often software WebGL in headless mode), not data loading.
- `status`: `ok`, `no_visual (...)`, `never_stable`, or `failed: ...`

Frame times are measured when a response starts arriving, not when its body finishes downloading, so treat `last_frame_ms` as approximate.

### Verify 3D results with the screenshots

The 3D check looks at pixels, so it can be fooled by something non-black on screen (a spinner or UI chrome). Open a screenshot from `shots/` (for example `shots/250MB_3d_cold_1.png`) and confirm the 3D view really appears. A 3D row marked `ok` with very few `frames` is a warning sign worth checking.

---

## 8. Recommended full run order

```powershell
# 1. clean up results and variables
Remove-Item upload.csv, studies.json, render.csv, render3d.csv -ErrorAction SilentlyContinue
Remove-Item -Recurse shots -ErrorAction SilentlyContinue
Remove-Item Env:FULL_LOAD, Env:NETWORK, Env:HEADED, Env:MODE, Env:RUNS, Env:HP, Env:VIEWPORTS -ErrorAction SilentlyContinue

# 2. upload every folder in scans/
npx playwright test upload.spec.js

# 3. quick sanity check on one study (check the [config] line and a screenshot)
$env:RUNS=1; $env:HEADED=1; npx playwright test bench.spec.js -g "250MB"

# 4. reset, then run the full benchmark
Remove-Item render.csv, render3d.csv
Remove-Item -Recurse shots
Remove-Item Env:RUNS, Env:HEADED
npx playwright test bench.spec.js

# 5. summarize: open the CSVs in Excel and report the MEDIAN per size and phase
```

## 9. Tips for fair results

- Report the **median** of the runs, not the average.
- Keep cold and warm results separate.
- Use `HEADED=1` on a real GPU for 3D. Headless Chromium uses software WebGL, which is much slower than a normal browser.
- Close other heavy apps while testing, and record your CPU, RAM, GPU, browser and OHIF version.
- Use the same transfer syntax (compression) across all sizes, since it changes file size and decode time.
- Don't leave `NETWORK` or `FULL_LOAD` set by accident. They change results a lot.
- Use more runs (5 or more) for anything you plan to report. The upload default of 2 is fine for a first look.
- A 500 MB or 1 GB study that times out or crashes the browser is a valid result. Report it as such.
- `heap_mb` is JS heap only. GPU memory isn't captured, so 3D may use more than it shows.

## 10. Troubleshooting

| Problem | Cause and fix |
|---|---|
| Upload test says "No sub-folders found" | `scans/` is missing or empty, or you are running from the wrong directory. Run from the `ohif-bench` folder. |
| Upload test says "No DICOM files found" | The folder has no `.dcm`, `.dicom` or extensionless files. |
| `orthanc_instances` is lower than `files` in `upload.csv` | Some uploads failed or files were merged. Check `failed_files` and `status`. |
| Load times are around 80 s or more for everything (2D, 3D, cold and warm alike) | A fixed delay, not rendering. Check the `[config]` line for a leftover `NETWORK` setting. Then time Orthanc's metadata response (see below). Also check that the study in `studies.json` has the instance count you expect. |
| 2D test fails with `locator.hover: Test ended` | `FULL_LOAD` is still set from an earlier run. Clear it (section 5). |
| CSV shows strange characters | The file was created with `echo >` in PowerShell (UTF-16). Delete it and let the script create it. |
| CSV columns look shifted or mixed | An old CSV from a previous version is being appended to. Delete it. |
| `studies.json not found` | Run `upload.spec.js` first. |
| `size_mb` is empty in the render CSVs | `studies.json` came from an older upload script. Re-run the upload. |
| `curl` commands fail or behave oddly in PowerShell | Use `curl.exe` instead of `curl`. |
| Test seems to hang for minutes | A step timed out. Check `status` in the CSV, and run one test with `--debug`. |
| `frames` column is 0 or 1, or very low in 3D | The `/frames/` URL filter may not match your OHIF requests. Copy an image request URL from DevTools (Network tab) and adjust the filter in `bench.spec.js`. |
| `no_visual (viewports seen: 1, ...)` | Wrong `HP` id or wrong `VIEWPORTS` count for your layout. |
| `viewports` is 0 in `render3d.csv` | Canvases don't use the `cornerstone-canvas` class in your OHIF version. Update the selector in `sampleViewports`. |
| 3D never appears in headless mode | Software WebGL is too slow or unavailable. Use `$env:HEADED=1`. |
| Upload fails with 4xx/5xx | Check Orthanc is running, the port in `ORTHANC_URL` is correct, and the files are valid DICOM. |

### Timing Orthanc's metadata response

If everything loads slowly, check whether the server is the bottleneck:

```powershell
curl.exe -s -o NUL -w "%{time_total}s  %{size_download} bytes`n" http://localhost:2000/dicom-web/studies/<STUDY_UID>/metadata
```

If this takes tens of seconds, the delay is on the server side (Orthanc building metadata for a large study), not in OHIF or the test. Get `<STUDY_UID>` from `studies.json`.