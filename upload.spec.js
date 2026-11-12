// upload.spec.js
// Uploads every DICOM file found in each folder under ./scans to Orthanc, times it,
// and writes detailed results to upload.csv. Also writes studies.json for bench.spec.js.
//
//   scans/250MB/*.dcm   -> label "250MB"
//   scans/500MB/*.dcm   -> label "500MB"
//   scans/1GB/...       -> label "1GB"      (folders are discovered automatically)
//
// Env options (PowerShell: $env:NAME="value"):
//   ORTHANC_URL=http://localhost:2000
//   RUNS=2
//   SCANS_DIR=scans

const { test, request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ORTHANC = process.env.ORTHANC_URL || 'http://localhost:2000';
const RUNS = parseInt(process.env.RUNS || '1', 10);
const SCANS_DIR = process.env.SCANS_DIR || 'scans';
const CSV = 'upload.csv';
const STUDIES = 'studies.json';

const CSV_HEADER = [
  'timestamp', 'label', 'run', 'files', 'total_bytes', 'total_mb',
  'seconds', 'post_seconds', 'mb_per_s', 'files_per_s',
  'avg_ms_per_file', 'median_ms_per_file', 'max_ms_per_file',
  'failed_files', 'already_stored', 'orthanc_instances', 'orthanc_series',
  'orthanc_disk_mb', 'study_uid', 'status',
].join(',');

if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, CSV_HEADER + '\n', 'utf8');

// ---------- helpers ----------

function sizeToBytes(label) {
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i.exec(label);
  if (!m) return Infinity;
  const mult = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * mult;
}

// folders under scans/, smallest labelled size first
function discoverLabels() {
  if (!fs.existsSync(SCANS_DIR)) return [];
  return fs
    .readdirSync(SCANS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => sizeToBytes(a) - sizeToBytes(b) || a.localeCompare(b));
}

// all DICOM files in a folder, including subfolders (.dcm, .dicom, or no extension)
function listDicomFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDicomFiles(full));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.dcm' || ext === '.dicom' || ext === '') out.push(full);
    }
  }
  return out.sort();
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function saveStudyEntry(entry) {
  const all = fs.existsSync(STUDIES) ? JSON.parse(fs.readFileSync(STUDIES, 'utf8')) : [];
  const filtered = all.filter((e) => e.label !== entry.label); // replace, don't duplicate
  filtered.push(entry);
  fs.writeFileSync(STUDIES, JSON.stringify(filtered, null, 2));
}

// ---------- tests ----------

test.describe.configure({ mode: 'serial' });

const labels = discoverLabels();
if (!labels.length) {
  test('no scan folders found', async () => {
    throw new Error(`No sub-folders found in "${SCANS_DIR}". Expected e.g. ${SCANS_DIR}/250MB/*.dcm`);
  });
}

for (const label of labels) {
  test(`upload ${label}`, async () => {
    test.setTimeout(60 * 60 * 1000); // up to 1 hour per size

    const api = await request.newContext({ baseURL: ORTHANC, timeout: 10 * 60 * 1000 });
    const dir = path.join(SCANS_DIR, label);
    const files = listDicomFiles(dir);
    if (!files.length) throw new Error(`No DICOM files found in ${dir}`);

    const totalBytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    console.log(
      `[${label}] ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB on disk, uploading to ${ORTHANC} (${RUNS} runs)`
    );

    const rows = [];
    let lastStudyIds = [];
    let lastStudyUid = '';
    let lastInstances = 0;

    for (let run = 1; run <= RUNS; run++) {
      const perFileMs = [];
      const studyCounts = {};
      let failed = 0, alreadyStored = 0, firstError = '';
      let postMs = 0;

      const t0 = Date.now();
      for (const f of files) {
        const buf = fs.readFileSync(f); // disk read counts in wall time, not in post_seconds
        const p0 = Date.now();
        try {
          const r = await api.post('/instances', {
            data: buf,
            headers: { 'Content-Type': 'application/dicom' },
          });
          const dt = Date.now() - p0;
          postMs += dt;
          perFileMs.push(dt);
          if (!r.ok()) {
            failed++;
            if (!firstError) firstError = `HTTP ${r.status()} on ${path.basename(f)}`;
            continue;
          }
          const body = await r.json();
          if (body.Status === 'AlreadyStored') alreadyStored++;
          if (body.ParentStudy) studyCounts[body.ParentStudy] = (studyCounts[body.ParentStudy] || 0) + 1;
        } catch (err) {
          failed++;
          if (!firstError) firstError = String(err.message).split('\n')[0].replace(/,/g, ';');
        }
      }
      const sec = (Date.now() - t0) / 1000;

      // the folder should hold one study; if not, use the biggest one for the benchmark
      const studyIds = Object.keys(studyCounts);
      if (studyIds.length > 1) {
        console.warn(`[${label}] WARNING: files belong to ${studyIds.length} different studies; using the largest.`);
      }
      const mainStudy = studyIds.sort((a, b) => studyCounts[b] - studyCounts[a])[0];

      // ask Orthanc what it actually stored
      let oInstances = '', oSeries = '', oDiskMb = '', studyUid = '';
      if (mainStudy) {
        try {
          const stats = await (await api.get(`/studies/${mainStudy}/statistics`)).json();
          oInstances = stats.CountInstances;
          oSeries = stats.CountSeries;
          oDiskMb = stats.DiskSizeMB;
          const info = await (await api.get(`/studies/${mainStudy}`)).json();
          studyUid = info.MainDicomTags.StudyInstanceUID;
        } catch (err) {
          firstError = firstError || 'stats lookup failed';
        }
      }

      let status = 'ok';
      if (failed) status = `failed_files: ${firstError}`;
      else if (!mainStudy) status = 'no_study_created';

      const row = {
        timestamp: new Date().toISOString(),
        label,
        run,
        files: files.length,
        total_bytes: totalBytes,
        total_mb: +(totalBytes / 1e6).toFixed(2),
        seconds: +sec.toFixed(3),
        post_seconds: +(postMs / 1000).toFixed(3),
        mb_per_s: +(totalBytes / 1e6 / sec).toFixed(3),
        files_per_s: +(files.length / sec).toFixed(2),
        avg_ms_per_file: perFileMs.length ? +(postMs / perFileMs.length).toFixed(1) : '',
        median_ms_per_file: +median(perFileMs).toFixed(1),
        max_ms_per_file: perFileMs.length ? Math.max(...perFileMs) : '',
        failed_files: failed,
        already_stored: alreadyStored,
        orthanc_instances: oInstances,
        orthanc_series: oSeries,
        orthanc_disk_mb: oDiskMb,
        study_uid: studyUid,
        status: status.replace(/,/g, ';'),
      };
      rows.push(row);
      fs.appendFileSync(CSV, Object.values(row).join(',') + '\n', 'utf8');

      lastStudyIds = studyIds;
      lastStudyUid = studyUid;
      lastInstances = typeof oInstances === 'number' ? oInstances : files.length;

      // wipe between runs so each upload is fresh; keep the final run's study
      if (run < RUNS) {
        for (const id of studyIds) await api.delete(`/studies/${id}`).catch(() => {});
      }
    }

    if (lastStudyUid) {
      saveStudyEntry({
        label,
        uid: lastStudyUid,
        instances: lastInstances,
        size_mb: +(totalBytes / 1e6).toFixed(2),
        files: files.length,
      });
    } else {
      console.warn(`[${label}] no study UID captured; ${STUDIES} not updated for this size.`);
    }

    console.table(
      rows.map((r) => ({
        size: r.label, run: r.run, files: r.files, MB: r.total_mb, sec: r.seconds,
        'MB/s': r.mb_per_s, 'files/s': r.files_per_s, failed: r.failed_files, status: r.status,
      }))
    );
    await api.dispose();
  });
}