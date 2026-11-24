const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { resolveTemplate, generationInputs, hasShotDraft, supportsShotReferences, shotValues, shotDuration, analysisInputs,
  inputMediaKinds, validateLtxShotDuration } = require('./templates.cjs');
const assetFiles = require('./asset-file.cjs');

let db;
let file;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const trackKinds = ['video', 'audio', 'subtitle'];
const editorSections = new Set(['inputs', 'analysis', 'shots', 'workflow', 'clip']);
const activeStatuses = ['queued', 'preparing', 'running', 'reconnecting', 'collecting', 'rendering', 'disconnected'];
const assetTrashFolder = '.imodureel-trash';
const pendingStoryboards = new Map();
const timelineHistoryLimit = 41;

async function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await require('sql.js')({ locateFile: () => wasm });
  db?.close();
  file = path.join(dataDir, 'imodureel.sqlite');
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  db = new SQL.Database(saved);
  db.run(`
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,dir TEXT NOT NULL,template_id TEXT NOT NULL,template_version INTEGER NOT NULL,template_snapshot TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_archives(project_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shots(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,position INTEGER NOT NULL,title TEXT NOT NULL,prompt TEXT NOT NULL,duration REAL NOT NULL,dialogue TEXT NOT NULL,status TEXT NOT NULL,scene TEXT NOT NULL DEFAULT '',characters TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,prompt_id TEXT,detail TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_workflows(id TEXT PRIMARY KEY, specification TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_project_history ON jobs(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS clips(id TEXT PRIMARY KEY,track_id TEXT NOT NULL,asset_id TEXT,start REAL NOT NULL,in_point REAL NOT NULL,duration REAL NOT NULL,volume REAL NOT NULL,text TEXT NOT NULL,transition TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timeline_history (
      project_id TEXT NOT NULL, position INTEGER NOT NULL, action TEXT, tracks TEXT NOT NULL,
      current INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, position)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS timeline_history_cursor ON timeline_history(project_id) WHERE current = 1;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_state(project_id TEXT PRIMARY KEY, production TEXT NOT NULL DEFAULT '{}', workflow TEXT);
    CREATE TABLE IF NOT EXISTS editor_drafts(
      project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (project_id, section)
    );
    CREATE TABLE IF NOT EXISTS asset_metadata(asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, duration REAL, job_id TEXT, output_key TEXT, revision INTEGER NOT NULL DEFAULT 0, sha256 TEXT, generated_sha256 TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS asset_job_output ON asset_metadata(job_id, output_key);
    CREATE TABLE IF NOT EXISTS asset_trash(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL, stamp TEXT NOT NULL);
  `);
  const assetColumns = all('PRAGMA table_info(asset_metadata)').map(column => column.name);
  if (!assetColumns.includes('revision')) {
    db.run('ALTER TABLE asset_metadata ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  if (!assetColumns.includes('sha256')) db.run('ALTER TABLE asset_metadata ADD COLUMN sha256 TEXT');
  if (!assetColumns.includes('generated_sha256')) {
    db.run('ALTER TABLE asset_metadata ADD COLUMN generated_sha256 TEXT');
    db.run(`UPDATE asset_metadata SET generated_sha256 = sha256 WHERE revision = 0 AND job_id IS NOT NULL
      AND asset_id IN (SELECT id FROM assets WHERE origin = 'comfy')`);
  }
  const shotColumns = all('PRAGMA table_info(shots)').map(column => column.name);
  if (!shotColumns.includes('scene')) db.run("ALTER TABLE shots ADD COLUMN scene TEXT NOT NULL DEFAULT ''");
  if (!shotColumns.includes('characters')) db.run("ALTER TABLE shots ADD COLUMN characters TEXT NOT NULL DEFAULT '[]'");
  if (!shotColumns.includes('reference_image_id')) db.run('ALTER TABLE shots ADD COLUMN reference_image_id TEXT');
  if (!shotColumns.includes('dialogue_audio_id')) db.run('ALTER TABLE shots ADD COLUMN dialogue_audio_id TEXT');
  // Older releases declared asset_id NOT NULL even though captions have no asset.
  if (all('PRAGMA table_info(clips)').find(column => column.name === 'asset_id').notnull) {
    db.run(`BEGIN;
      ALTER TABLE clips RENAME TO clips_legacy;
      CREATE TABLE clips(id TEXT PRIMARY KEY,track_id TEXT NOT NULL,asset_id TEXT,start REAL NOT NULL,in_point REAL NOT NULL,duration REAL NOT NULL,volume REAL NOT NULL,text TEXT NOT NULL,transition TEXT NOT NULL);
      INSERT INTO clips SELECT * FROM clips_legacy;
      DROP TABLE clips_legacy;
      COMMIT;`);
  }
  const clipColumns = all('PRAGMA table_info(clips)').map(column => column.name);
  if (!clipColumns.includes('linked_video_id')) {
    db.run('ALTER TABLE clips ADD COLUMN linked_video_id TEXT');
  }
  if (!clipColumns.includes('split_offset')) db.run('ALTER TABLE clips ADD COLUMN split_offset REAL');
  if (!clipColumns.includes('split_duration')) db.run('ALTER TABLE clips ADD COLUMN split_duration REAL');
  if (!clipColumns.includes('dialogue_window')) db.run('ALTER TABLE clips ADD COLUMN dialogue_window TEXT');
  db.run('CREATE INDEX IF NOT EXISTS clips_linked_video ON clips(linked_video_id) WHERE linked_video_id IS NOT NULL');
  migrateJobWorkflows();
  const migrated = Buffer.from(db.export());
  if (saved?.equals(migrated)) return;
  try { save(migrated); }
  catch (error) {
    // Existing projects remain readable. The next successful write saves the migrated database.
    if (!saved || !assetFiles.isStorageFull(error)) throw error;
  }
}

function save(image) {
  const temporary = file + '.tmp';
  try {
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, image ?? Buffer.from(db.export()));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function transaction(write) {
  // sql.js cannot export while a transaction is open. Preserve the previous
  // database in case replacing the on-disk copy fails after the SQL commit.
  const previous = db.export();
  db.run('BEGIN');
  let committed = false;
  try {
    const result = write();
    db.run('COMMIT');
    committed = true;
    save();
    return result;
  } catch (error) {
    if (committed) {
      const Database = db.constructor;
      db.close();
      db = new Database(previous);
    } else {
      db.run('ROLLBACK');
    }
    throw error;
  }
}

function run(sql, params = []) {
  return transaction(() => db.run(sql, params));
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function one(sql, params = []) {
  return all(sql, params)[0] || null;
}

function encodeJobDetails() {
  const references = new WeakMap();
  const written = new Set();
  return (kind, detail) => {
    if (kind !== 'comfy' || !detail.workflow || typeof detail.workflow !== 'object') return JSON.stringify(detail);
    const { workflow, mapping, ...parameters } = detail;
    if (!references.has(workflow)) references.set(workflow, new Map());
    const byMapping = references.get(workflow);
    if (!byMapping.has(mapping)) {
      const specification = JSON.stringify({ workflow, mapping });
      const reference = crypto.createHash('sha256').update(specification).digest('hex');
      if (!written.has(reference)) {
        db.run('INSERT OR IGNORE INTO job_workflows(id, specification) VALUES (?, ?)', [reference, specification]);
        written.add(reference);
      }
      byMapping.set(mapping, reference);
    }
    return JSON.stringify({ ...parameters, workflowRef: byMapping.get(mapping) });
  };
}

function migrateJobWorkflows() {
  const legacy = "kind = 'comfy' AND json_type(detail, '$.workflow') IN ('object', 'array')";
  if (!one(`SELECT 1 FROM jobs WHERE ${legacy} LIMIT 1`)) return;
  const encode = encodeJobDetails();
  db.run('BEGIN');
  try {
    for (let after = 0;;) {
      const batch = all(`SELECT rowid, detail FROM jobs WHERE rowid > ? AND ${legacy} ORDER BY rowid LIMIT 16`, [after]);
      if (!batch.length) break;
      for (const job of batch) {
        db.run('UPDATE jobs SET detail = ? WHERE rowid = ?', [encode('comfy', JSON.parse(job.detail)), job.rowid]);
      }
      after = batch.at(-1).rowid;
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  // Remove the pages that used to hold one workflow per shot before the atomic save.
  db.run('VACUUM');
}

function jobWorkflow(reference) {
  const row = one('SELECT specification FROM job_workflows WHERE id = ?', [reference]);
  if (!row) throw new Error('任务的工作流快照缺失，请从项目重新提交');
  return JSON.parse(row.specification);
}

function projectRow(projectId) {
  const row = one(`SELECT p.*, a.archived_at FROM projects p
    LEFT JOIN project_archives a ON a.project_id = p.id WHERE p.id = ?`, [projectId]);
  if (!row) throw new Error('项目不存在');
  return row;
}

function listProjects(includeArchived = false) {
  return all(`SELECT p.id, p.name, p.dir, p.template_id, p.template_version, p.updated_at, a.archived_at
    FROM projects p LEFT JOIN project_archives a ON a.project_id = p.id
    WHERE a.archived_at IS NULL OR ? = 1 ORDER BY p.updated_at DESC, p.rowid DESC`, [Number(includeArchived)]);
}

function editableProject(projectId) {
  const project = projectRow(projectId);
  if (project.archived_at) throw new Error('项目已归档，请先恢复到项目列表');
  return project;
}

function touch(projectId) {
  editableProject(projectId);
  db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [now(), projectId]);
}

const pathKey = value => ['win32', 'darwin'].includes(process.platform) ? value.toLowerCase() : value;

function checkProjectDirectory(dir, excludeProjectId) {
  for (const project of all('SELECT id, dir FROM projects')) {
    if (project.id === excludeProjectId) continue;
    const existing = fs.existsSync(project.dir) ? fs.realpathSync(project.dir) : path.resolve(project.dir);
    if (pathKey(existing) === pathKey(dir)) throw new Error('此目录已用于其他项目，请选择另一个目录');
  }
}

function createProject(name, dir, template) {
  if (typeof name !== 'string' || !name.trim() || !dir) throw new Error('请输入名称并选择目录');
  fs.mkdirSync(dir, { recursive: true });
  dir = fs.realpathSync(dir);
  checkProjectDirectory(dir);
  for (const folder of ['assets', 'exports', 'workflows']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  const project = {
    id: id(), name: name.trim(), dir, template_id: template.id, template_version: template.version,
    template_snapshot: JSON.stringify(template), created_at: now(), updated_at: now(),
  };
  run('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?)', Object.values(project));
  return project;
}

function renameProject(projectId, name) {
  const project = editableProject(projectId);
  if (typeof name !== 'string' || !name.trim()) throw new Error('请输入项目名称');
  const nextName = name.trim();
  if (nextName === project.name) return;
  run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', [nextName, now(), projectId]);
}

function archiveProject(projectId) {
  if (projectRow(projectId).archived_at) return;
  if (one(`SELECT id FROM jobs WHERE project_id = ? AND status IN
    ('queued','preparing','running','reconnecting','collecting','rendering','disconnected') LIMIT 1`, [projectId])) {
    throw new Error('请在任务页完成、恢复或取消未结束的任务，再归档项目');
  }
  transaction(() => {
    const archivedAt = now();
    db.run('INSERT INTO project_archives VALUES (?, ?)', [projectId, archivedAt]);
    db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [archivedAt, projectId]);
  });
}

function unarchiveProject(projectId) {
  if (!projectRow(projectId).archived_at) return;
  transaction(() => {
    db.run('DELETE FROM project_archives WHERE project_id = ?', [projectId]);
    touch(projectId);
  });
}

function restoreProject(snapshot) {
  const dir = fs.realpathSync(snapshot.dir);
  checkProjectDirectory(dir);
  const project = {
    id: id(), name: snapshot.name, dir, template_id: snapshot.template.id, template_version: snapshot.template.version,
    template_snapshot: JSON.stringify(snapshot.template), created_at: now(), updated_at: now(),
  };
  return transaction(() => {
    db.run('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?)', Object.values(project));
    db.run('INSERT INTO project_state (project_id, production, workflow) VALUES (?,?,?)', [
      project.id, JSON.stringify(snapshot.production), snapshot.workflow ? JSON.stringify(snapshot.workflow) : null,
    ]);
    const encode = encodeJobDetails();
    for (const job of snapshot.jobs) db.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)', [
      job.id, project.id, job.kind, job.status, null, encode(job.kind, job.detail), job.created_at || now(),
    ]);
    for (const asset of snapshot.assets) {
      db.run('INSERT INTO assets VALUES (?,?,?,?,?,?)', [
        asset.id, project.id, asset.path, asset.kind, asset.origin, asset.created_at || now(),
      ]);
      db.run(`INSERT INTO asset_metadata (asset_id, name, duration, job_id, output_key, revision, sha256, generated_sha256)
        VALUES (?,?,?,?,?,?,?,?)`, [
        asset.id, asset.name, asset.duration ?? null, asset.job_id ?? null, asset.output_key ?? null, asset.revision ?? 0,
        asset.sha256 ?? null, asset.generated_sha256 ??
          (asset.origin === 'comfy' && asset.job_id && !(asset.revision ?? 0) ? asset.sha256 ?? null : null),
      ]);
    }
    const shots = normalizeShots(snapshot.shots);
    validateShotAssets(project, shots);
    for (const [position, shot] of shots.entries()) {
      insertShot(project.id, shot, position, snapshot.shots[position].status);
    }
    insertTimeline(project.id, snapshot.tracks, Boolean(snapshot.timelineHistory));
    if (snapshot.timelineHistory) {
      const { cursor, entries } = snapshot.timelineHistory;
      const currentTracks = projectTracks(project.id, true);
      for (const [position, { action, tracks }] of entries.entries()) {
        const restoredTracks = position === cursor ? currentTracks : tracks.map(track => ({ ...track, project_id: project.id }));
        db.run('INSERT INTO timeline_history VALUES (?, ?, ?, ?, ?)',
          [project.id, position, action, JSON.stringify(restoredTracks), Number(position === cursor)]);
      }
    }
    for (const [section, draft] of Object.entries(snapshot.editorDrafts ?? {})) {
      writeEditorDraft(project.id, section, JSON.stringify(draft));
    }
    return project;
  });
}

function requireIdleProject(projectId) {
  if (one(`SELECT id FROM jobs WHERE project_id = ? AND status IN
    ('queued','preparing','running','reconnecting','collecting','rendering') LIMIT 1`, [projectId])) {
    throw new Error('请等待项目中的任务结束，或取消后再重新定位目录');
  }
}

async function relocateProject(projectId, selectedDir, acceptedUnverified) {
  const owner = editableProject(projectId);
  const directory = fs.realpathSync(selectedDir);
  if (!fs.statSync(directory).isDirectory()) throw new Error('请选择项目文件夹');
  if (directory === owner.dir) return;
  checkProjectDirectory(directory, projectId);
  requireIdleProject(projectId);
  const rebase = file => {
    if (typeof file !== 'string') return file;
    const relative = path.relative(owner.dir, file);
    return path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
      ? file : path.join(directory, relative);
  };
  const current = assets(projectId);
  const listJobs = () => all('SELECT id, detail FROM jobs WHERE project_id = ? ORDER BY rowid', [projectId]);
  const jobs = listJobs();
  const moved = current.filter(asset => asset.path !== rebase(asset.path));
  if (moved.length && !moved.some(asset => fs.statSync(rebase(asset.path), { throwIfNoEntry: false })?.isFile()) &&
      !['assets', 'exports'].every(folder => fs.statSync(path.join(directory, folder), { throwIfNoEntry: false })?.isDirectory())) {
    throw new Error('所选目录中找不到任何项目素材，请选择移动后的项目根目录');
  }
  const currentById = new Map(current.map(asset => [asset.id, asset]));
  const details = jobs.map(({ id, detail }) => ({ id, detail: JSON.parse(detail) }));
  for (const { detail } of details) {
    for (const asset of detail.snapshot?.assets ?? []) {
      const latest = currentById.get(asset.id);
      if (asset.path === latest?.path && asset.sha256 && latest?.sha256 && asset.sha256 !== latest.sha256) {
        asset.path = null;
      }
    }
  }
  const sources = [...moved, ...details.flatMap(({ detail }) => detail.snapshot?.assets ?? [])]
    .filter(asset => asset.path !== rebase(asset.path));
  const checks = new Map();
  for (const asset of sources) {
    if (!checks.has(asset.path)) checks.set(asset.path, { name: asset.name, expected: new Set() });
    if (asset.sha256) checks.get(asset.path).expected.add(asset.sha256);
  }
  const statFile = filename => {
    const stat = fs.statSync(filename, { throwIfNoEntry: false });
    return stat?.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : null;
  };
  const unverified = [];
  for (const [previous, check] of checks) {
    const target = rebase(previous);
    check.stat = statFile(target);
    if (!check.stat) continue;
    check.sha256 = await assetFiles.assetFingerprint(target);
    if (!check.expected.size && statFile(previous)) check.expected.add(await assetFiles.assetFingerprint(previous));
    if (!check.expected.size) {
      unverified.push({ file: path.relative(directory, target), name: check.name, sha256: check.sha256 });
    } else if ([...check.expected].some(hash => hash !== check.sha256)) {
      throw new Error(`所选目录中的文件与原素材内容不同：${check.name || path.basename(previous)}。请选择正确的目录，或先移出不同的文件，迁移后再逐项重新定位。`);
    }
  }
  if (unverified.length && !isDeepStrictEqual(unverified, acceptedUnverified)) return { unverified };
  if (editableProject(projectId).dir !== owner.dir || !isDeepStrictEqual(current, assets(projectId)) ||
      !isDeepStrictEqual(jobs, listJobs()) ||
      [...checks].some(([previous, check]) => !isDeepStrictEqual(check.stat, statFile(rebase(previous))))) {
    throw new Error('检查期间项目或文件已变更，请重新定位项目目录');
  }
  requireIdleProject(projectId);
  checkProjectDirectory(directory, projectId);
  transaction(() => {
    db.run('UPDATE projects SET dir = ? WHERE id = ?', [directory, projectId]);
    for (const asset of moved) {
      db.run('UPDATE assets SET path = ? WHERE id = ?', [rebase(asset.path), asset.id]);
      const sha256 = checks.get(asset.path)?.sha256;
      if (sha256 && !asset.sha256) db.run(`INSERT INTO asset_metadata (asset_id, name, sha256) VALUES (?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET sha256 = excluded.sha256`, [asset.id, asset.name, sha256]);
    }
    for (const { id, detail } of details) {
      if (!detail.file && !detail.snapshot) continue;
      if (detail.file) detail.file = rebase(detail.file);
      if (detail.snapshot) {
        detail.snapshot.dir = rebase(detail.snapshot.dir);
        detail.snapshot.assets = detail.snapshot.assets.map(asset => {
          const sha256 = asset.sha256 || checks.get(asset.path)?.sha256;
          return { ...asset, path: rebase(asset.path), ...(sha256 && { sha256 }) };
        });
      }
      db.run('UPDATE jobs SET detail = ? WHERE id = ?', [JSON.stringify(detail), id]);
    }
    for (const item of pendingAssetTrash(projectId)) {
      db.run('UPDATE asset_trash SET source = ? WHERE id = ?', [rebase(item.source), item.id]);
    }
    touch(projectId);
  });
}

const assetRecords = `SELECT a.*, m.name, m.duration, m.job_id, m.output_key, m.sha256, m.generated_sha256, coalesce(m.revision, 0) AS revision FROM assets a
    LEFT JOIN asset_metadata m ON a.id = m.asset_id`;

function assetRecord(id) {
  return one(assetRecords + ' WHERE a.id = ?', [id]);
}

function assets(projectId) {
  return all(assetRecords + ' WHERE a.project_id = ? ORDER BY a.created_at, a.rowid', [projectId])
    .map(asset => ({ ...asset, name: asset.name || path.basename(asset.path), exists: fs.existsSync(asset.path) }));
}

function enhancementReviews(project) {
  if (project.production.enhancementReviews) return project.production.enhancementReviews;
  // Older builds saved one selection. Any enhanced asset already in the
  // timeline also passed approval once, provided its bytes were never replaced.
  const legacy = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.asset_id)));
  legacy.add(project.production.approvedOutput);
  return Object.fromEntries(project.assets.filter(asset => asset.origin === 'comfy' && asset.kind === 'video' &&
    asset.revision === 0 && legacy.has(asset.id)).map(asset => [asset.id, 0]));
}

function approveEnhancement(projectId, assetId, revision) {
  const current = project(projectId, { includeWorkflow: false });
  const asset = current.assets.find(item => item.id === assetId);
  if (current.template_id !== 'enhance' || !asset?.exists || asset.kind !== 'video' || asset.origin !== 'comfy') {
    throw new Error('请选择该项目可用的增强结果');
  }
  if (revision !== asset.revision) throw new Error('增强结果已更新，请查看当前版本后再确认');
  saveProduction(projectId, { enhancementReviews: { ...enhancementReviews(current), [assetId]: asset.revision } });
}

function requireEnhancementReview(asset) {
  if (asset?.enhancementReviewRequired) throw new Error(`请在生成页重新确认增强结果：${asset.name}`);
}

function project(projectId, { jobDetails = 'record', includeWorkflow = true, includeDialogueWindows = false } = {}) {
  const row = projectRow(projectId);
  const state = one(`SELECT ${includeWorkflow ? 'production, workflow' : 'production'} FROM project_state WHERE project_id = ?`, [projectId]);
  const jobs = all('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC', [projectId]);
  if (jobDetails === 'summary') {
    for (const job of jobs) {
      if (job.kind !== 'comfy') continue;
      const { workflowRef, workflow, mapping, outputReceipt, submissionPending, ...summary } = JSON.parse(job.detail);
      job.detail = JSON.stringify(summary);
    }
  }
  const result = {
    ...row,
    production: JSON.parse(state?.production || '{}'),
    editorDrafts: Object.fromEntries(all('SELECT section, content FROM editor_drafts WHERE project_id = ?', [projectId])
      .map(({ section, content }) => [section, JSON.parse(content)])),
    workflow: state?.workflow ? JSON.parse(state.workflow) : null,
    assets: assets(projectId),
    shots: all('SELECT * FROM shots WHERE project_id = ? ORDER BY position', [projectId])
      .map(({ reference_image_id, dialogue_audio_id, ...shot }) => ({
        ...shot, characters: JSON.parse(shot.characters), ...(reference_image_id && { reference_image_id }),
        ...(dialogue_audio_id && { dialogue_audio_id }),
      })),
    jobs,
    tracks: projectTracks(projectId, includeDialogueWindows),
  };
  if (row.template_id === 'enhance') {
    const reviews = enhancementReviews(result);
    for (const asset of result.assets) {
      if (asset.origin === 'comfy' && asset.kind === 'video') {
        asset.enhancementReviewRequired = reviews[asset.id] !== asset.revision;
      }
    }
  }
  return result;
}

function production(projectId) {
  const state = one('SELECT production FROM project_state WHERE project_id = ?', [projectId]);
  return JSON.parse(state?.production || '{}');
}

function inputAsset(projectId, assetId, kinds, { allowMissing = false } = {}) {
  const asset = assets(projectId).find(item => item.id === assetId);
  if (!asset || !allowMissing && !asset.exists) throw new Error('请重新选择或定位项目素材');
  if (kinds && !kinds.includes(asset.kind)) throw new Error('素材类型不符合该步骤的要求');
  return asset;
}

async function addMedia(projectId, entries, signal, onFileError) {
  const owner = editableProject(projectId);
  const directory = path.join(owner.dir, 'assets');
  await fs.promises.mkdir(directory, { recursive: true });
  const staged = [];
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const assetId = id();
      const target = path.join(directory, assetId + path.extname(entry.src));
      const media = { ...entry, id: assetId, path: target };
      try {
        media.sha256 = await assetFiles.copyAssetFile(entry.src, target, signal);
        staged.push(media);
      } catch (error) {
        if (error.code !== 'EEXIST') await fs.promises.rm(target, { force: true }).catch(() => {});
        if (!onFileError || signal?.aborted) throw error;
        onFileError(entry, error);
      }
    }
    signal?.throwIfAborted();
    if (!staged.length) return [];
    return transaction(() => {
      if (projectRow(projectId).dir !== owner.dir) throw new Error('项目目录已更新，请重新导入或收集素材');
      const imported = staged.map(entry => entry.restoreId ? restoreAsset(projectId, entry) : insertAsset(projectId, entry));
      touch(projectId);
      return imported;
    });
  } catch (error) {
    await Promise.allSettled(staged.map(entry => fs.promises.rm(entry.path, { force: true })));
    throw error;
  }
}

function cleanupState(projectId) {
  editableProject(projectId);
  const current = project(projectId, { includeWorkflow: false, includeDialogueWindows: true });
  const inputIds = inputs => Object.keys(inputMediaKinds).map(key => inputs?.[key]);
  const shotAssets = [current.shots, current.production.draftShots ?? [], current.editorDrafts.shots ?? []]
    .flatMap(shots => shots.flatMap(shot => [shot?.reference_image_id, shot?.dialogue_audio_id]));
  const used = new Set([
    ...inputIds(current.production.inputs), ...inputIds(current.editorDrafts.inputs),
    ...shotAssets,
    current.editorDrafts.clip?.asset_id,
    ...Object.values(current.production.shotSelections ?? {}),
    ...current.tracks.flatMap(track => track.clips.map(clip => clip.asset_id)),
  ]);
  for (const { id } of all(`SELECT DISTINCT json_extract(clip.value, '$.asset_id') AS id
    FROM timeline_history h, json_each(h.tracks) AS track, json_each(track.value, '$.clips') AS clip
    WHERE h.project_id = ?`, [projectId])) used.add(id);
  const jobs = current.jobs.map(job => ({ ...job, detail: JSON.parse(job.detail) }));
  const active = new Set(jobs.filter(job => activeStatuses.includes(job.status)).map(job => job.id));
  for (const { id, kind, status, detail } of jobs) {
    if (kind === 'preview' && status === 'done') continue;
    for (const assetId of Object.values(detail.assetInputs ?? {})) used.add(assetId);
    for (const asset of detail.snapshot?.assets ?? []) used.add(asset.id);
    for (const track of detail.snapshot?.tracks ?? []) {
      for (const clip of track.clips) used.add(clip.asset_id);
    }
    if (active.has(id)) for (const assetId of detail.assets ?? []) used.add(assetId);
  }
  const candidates = current.assets.filter(asset => !used.has(asset.id) && !active.has(asset.job_id));
  return { current, candidates, jobs };
}

function assetCleanupPlan(projectId) {
  const { current, candidates } = cleanupState(projectId);
  return {
    assets: candidates.map(({ id, name, kind, exists }) => ({ id, name, kind, exists })),
    protectedCount: current.assets.length - candidates.length,
    pendingCount: pendingAssetTrash(projectId).length,
  };
}

function referencePaths(excludedIds = new Set()) {
  const files = all('SELECT id, path FROM assets').filter(asset => !excludedIds.has(asset.id)).map(asset => asset.path);
  files.push(...all(`SELECT json_extract(media.value, '$.path') AS path
    FROM jobs, json_each(jobs.detail, '$.snapshot.assets') AS media
    WHERE jobs.kind <> 'preview' OR jobs.status <> 'done'`).map(asset => asset.path));
  const referenced = new Set();
  for (const file of new Set(files.filter(Boolean))) {
    referenced.add(pathKey(path.resolve(file)));
    try { referenced.add(pathKey(fs.realpathSync(file))); } catch {}
  }
  return referenced;
}

function ownedMediaStat(directory, filename) {
  const root = path.join(directory, 'assets');
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    return stat?.isFile() && pathKey(fs.realpathSync(filename)) === pathKey(path.resolve(filename)) ? stat : null;
  } catch {
    return null;
  }
}

function fileStamp(stat) {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

function removeUnusedAssets(projectId, selection) {
  if (!Array.isArray(selection) || !selection.length || selection.some(item => typeof item !== 'string')) {
    throw new Error('请选择要移除的素材');
  }
  const { current, candidates, jobs } = cleanupState(projectId);
  const ids = new Set(selection);
  const removed = candidates.filter(asset => ids.has(asset.id));
  if (removed.length !== ids.size) throw new Error('选中的素材已被使用或移除，请刷新清理列表后重试');

  const paths = referencePaths(ids);
  const queue = [];
  const retained = new Set();
  for (const asset of removed) {
    const key = pathKey(path.resolve(asset.path));
    if (paths.has(key)) {
      if (asset.exists) retained.add(key);
      continue;
    }
    const stat = ownedMediaStat(current.dir, asset.path);
    if (stat) {
      queue.push({ id: id(), source: asset.path, name: asset.name, stamp: fileStamp(stat) });
      paths.add(key);
    } else if (asset.exists) retained.add(key);
  }

  transaction(() => {
    for (const item of queue) db.run('INSERT INTO asset_trash VALUES (?, ?, ?, ?, ?)',
      [item.id, projectId, item.source, item.name, item.stamp]);
    for (const asset of removed) {
      db.run('DELETE FROM asset_metadata WHERE asset_id = ?', [asset.id]);
      db.run('DELETE FROM assets WHERE id = ?', [asset.id]);
    }
    for (const { id, detail } of jobs) {
      const kept = detail.assets?.filter(assetId => !ids.has(assetId));
      if (!kept || kept.length === detail.assets.length) continue;
      detail.removedAssetCount = (detail.removedAssetCount ?? 0) + detail.assets.length - kept.length;
      detail.assets = kept;
      db.run('UPDATE jobs SET detail = ? WHERE id = ?', [JSON.stringify(detail), id]);
    }
    const { approvedOutput, enhancementReviews } = current.production;
    if (ids.has(approvedOutput) || enhancementReviews) {
      writeProduction(projectId, {
        ...(ids.has(approvedOutput) && { approvedOutput: undefined }),
        ...(enhancementReviews && { enhancementReviews: Object.fromEntries(
          Object.entries(enhancementReviews).filter(([assetId]) => !ids.has(assetId))) }),
      });
    }
    touch(projectId);
  });
  for (const item of queue) retained.delete(pathKey(path.resolve(item.source)));
  return { removed: removed.length, retained: retained.size };
}

function pendingAssetTrash(projectId) {
  return all('SELECT * FROM asset_trash WHERE project_id = ? ORDER BY rowid', [projectId]);
}

function stageAssetTrash(projectId) {
  const { dir } = projectRow(projectId);
  const pending = pendingAssetTrash(projectId);
  if (!fs.existsSync(dir)) return pending.map(item => ({ ...item, error: '请先定位已移动的项目目录' }));
  const referenced = referencePaths();
  return pending.map(item => {
    const folder = path.join(path.dirname(item.source), assetTrashFolder);
    const staged = path.join(folder, item.id + path.extname(item.source));
    try {
      const parked = ownedMediaStat(dir, staged);
      if (parked) {
        const matches = isDeepStrictEqual(JSON.parse(fileStamp(parked)).slice(0, 4), JSON.parse(item.stamp).slice(0, 4));
        return matches && !referenced.has(pathKey(staged)) ? { ...item, staged } : { ...item, retained: true };
      }
      const stat = ownedMediaStat(dir, item.source);
      if (!stat || fileStamp(stat) !== item.stamp || referenced.has(pathKey(item.source))) {
        return { ...item, retained: fs.existsSync(item.source) || fs.existsSync(staged) };
      }
      fs.mkdirSync(folder, { recursive: true });
      if (pathKey(fs.realpathSync(folder)) !== pathKey(folder) || fs.existsSync(staged)) {
        throw new Error('无法使用素材清理暂存目录');
      }
      fs.renameSync(item.source, staged);
      return { ...item, staged };
    } catch (error) {
      return { ...item, error: error.message };
    }
  });
}

function finishAssetTrash(ids) {
  if (ids.length) transaction(() => {
    for (const id of ids) db.run('DELETE FROM asset_trash WHERE id = ?', [id]);
  });
}

function restoreAsset(projectId, entry) {
  const previous = one(`SELECT a.*, m.sha256 FROM assets a JOIN asset_metadata m ON a.id=m.asset_id
    WHERE a.id=? AND a.project_id=? AND m.job_id=? AND m.output_key=?`, [
    entry.restoreId, projectId, entry.jobId, entry.outputKey,
  ]);
  if (!previous || previous.kind !== entry.kind) throw new Error('无法恢复原任务的素材记录');
  if (previous.sha256 && previous.sha256 !== entry.sha256) {
    throw new Error('原任务返回的文件与已登记素材内容不一致，请重新定位原素材或提交新的生成任务');
  }
  db.run('UPDATE assets SET path = ? WHERE id = ?', [entry.path, previous.id]);
  db.run('UPDATE asset_metadata SET duration = ?, sha256 = ? WHERE asset_id = ?', [entry.duration ?? null, entry.sha256, previous.id]);
  return { ...previous, path: entry.path, name: entry.name, duration: entry.duration, job_id: entry.jobId, sha256: entry.sha256, exists: true };
}

function insertAsset(projectId, entry) {
  const asset = {
    id: entry.id, project_id: projectId, path: entry.path, kind: entry.kind,
    origin: entry.origin || 'import', created_at: now(),
  };
  db.run('INSERT INTO assets VALUES (?,?,?,?,?,?)', Object.values(asset));
  const name = entry.name || path.basename(entry.src);
  const generatedSha256 = asset.origin === 'comfy' && entry.jobId ? entry.sha256 : null;
  db.run('INSERT INTO asset_metadata(asset_id, name, duration, job_id, output_key, sha256, generated_sha256) VALUES (?,?,?,?,?,?,?)', [
    asset.id, name, entry.duration ?? null, entry.jobId ?? null, entry.outputKey ?? null, entry.sha256, generatedSha256,
  ]);
  return { ...asset, name, duration: entry.duration ?? null, job_id: entry.jobId ?? null, sha256: entry.sha256,
    generated_sha256: generatedSha256, exists: true };
}

async function relinkAsset(assetId, src, media) {
  const read = () => assetRecord(assetId);
  const asset = read();
  if (!asset) throw new Error('素材不存在');
  if (asset.kind !== media.kind) throw new Error('替换素材必须和原素材类型一致');
  const checkDuration = () => {
    const { end } = one(`SELECT max(coalesce(
      json_extract(dialogue_window, '$.inPoint') + json_extract(dialogue_window, '$.duration'), in_point + duration
    )) AS end FROM clips WHERE asset_id = ?`, [assetId]);
    if (media.duration != null && end > media.duration + 0.05) {
      throw new Error(`替换素材时长不足。当前片段使用至 ${end.toFixed(2)} 秒，请选择能覆盖该范围的文件`);
    }
  };
  checkDuration();
  const source = await fs.promises.realpath(src);
  if (!(await fs.promises.stat(source)).isFile()) throw new Error('替换素材必须是文件');
  const owner = editableProject(asset.project_id);
  const original = asset.sha256 ?? await assetFiles.assetFingerprint(asset.path).catch(() => null);
  const directory = path.join(owner.dir, 'assets');
  await fs.promises.mkdir(directory, { recursive: true });
  const relative = path.relative(await fs.promises.realpath(directory), source);
  const inProject = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const destination = inProject ? source : path.join(directory, id() + path.extname(src));
  try {
    const sha256 = inProject ? await assetFiles.assetFingerprint(source) : await assetFiles.copyAssetFile(source, destination);
    const changed = original !== sha256;
    transaction(() => {
      const current = read();
      if (current?.path !== asset.path || current.revision !== asset.revision || current.sha256 !== asset.sha256 ||
          inProject && !fs.existsSync(source) ||
          editableProject(asset.project_id).dir !== owner.dir) throw new Error('素材已更新，请重新选择');
      checkDuration();
      db.run('UPDATE assets SET path = ? WHERE id = ?', [destination, assetId]);
      const generatedSha256 = current.generated_sha256 ??
        (current.origin === 'comfy' && current.job_id && current.revision === 0 ? original : null);
      db.run(`INSERT INTO asset_metadata(asset_id, name, duration, revision, sha256, generated_sha256) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET name=excluded.name, duration=excluded.duration, revision=excluded.revision,
        sha256=excluded.sha256, generated_sha256=excluded.generated_sha256`,
      [assetId, media.name ?? path.basename(src), media.duration ?? null, asset.revision + Number(changed), sha256, generatedSha256]);
      const state = production(asset.project_id);
      if (changed && analysisInputs[owner.template_id]?.some(field => state.inputs?.[field] === assetId)) {
        writeProduction(asset.project_id, invalidateAnalysis(state));
      }
      touch(asset.project_id);
    });
  } catch (error) {
    if (!inProject) await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeShots(shots) {
  if (!Array.isArray(shots) || shots.length > 300) throw new Error('分镜列表无效或超过 300 个镜头');
  const ids = new Set();
  return shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object') throw new Error(`第 ${index + 1} 个镜头格式无效`);
    const shotId = shot.id || id();
    if (typeof shotId !== 'string' || ids.has(shotId)) throw new Error('分镜 ID 重复或无效');
    ids.add(shotId);
    return {
      id: shotId, title: String(shot.title || `镜头 ${index + 1}`).trim(),
      prompt: String(shot.prompt ?? '').trim(),
      duration: number(shot.duration ?? shotDuration.default, '镜头时长', shotDuration.min, shotDuration.max),
      dialogue: String(shot.dialogue ?? ''),
      scene: String(shot.scene ?? '').trim(),
      characters: Array.isArray(shot.characters) ? [...new Set(shot.characters.filter(value => typeof value === 'string')
        .map(value => value.trim()).filter(Boolean))] : [],
      ...(shot.reference_image_id != null && { reference_image_id: shot.reference_image_id }),
      ...(shot.dialogue_audio_id != null && { dialogue_audio_id: shot.dialogue_audio_id }),
    };
  });
}

function validateShotAssets(owner, shots) {
  const references = new Set(shots.map(shot => shot?.reference_image_id).filter(reference => reference != null));
  if (references.size && !supportsShotReferences(resolveTemplate(owner))) throw new Error('此模板版本不支持镜头参考图');
  for (const id of references) {
    const asset = typeof id === 'string' && assetRecord(id);
    if (!asset || asset.project_id !== owner.id || asset.kind !== 'image') {
      throw new Error('镜头参考图必须是当前项目的图片，请重新选择');
    }
  }
  const voices = new Set(shots.map(shot => shot?.dialogue_audio_id).filter(voice => voice != null));
  if (voices.size && owner.template_id !== 'drama') throw new Error('此模板不支持分镜配音');
  for (const id of voices) {
    const asset = typeof id === 'string' && assetRecord(id);
    if (!asset || asset.project_id !== owner.id || asset.kind !== 'audio') {
      throw new Error('分镜配音必须是当前项目的音频，请重新选择');
    }
  }
}

function insertShot(projectId, shot, position, status) {
  db.run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, dialogue, status, scene, characters,
    reference_image_id, dialogue_audio_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    shot.id, projectId, position, shot.title, shot.prompt, shot.duration, shot.dialogue, status,
    shot.scene, JSON.stringify(shot.characters), shot.reference_image_id ?? null, shot.dialogue_audio_id ?? null,
  ]);
}

function setShots(projectId, shots, approved = false) {
  const owner = projectRow(projectId);
  const normalized = normalizeShots(shots);
  validateShotAssets(owner, normalized);
  if (approved && (!normalized.length || normalized.some(shot => !shot.prompt))) {
    throw new Error('至少要有一个分镜，每个镜头须填写画面提示词');
  }
  if (approved && loadWorkflow(projectId)?.mapping?.frameCount) {
    for (const shot of normalized) validateLtxShotDuration(shot.duration);
  }
  return transaction(() => {
    const state = production(projectId);
    const retainedShots = new Set(approved ? normalized.map(shot => shot.id) : []);
    const selections = Object.entries(state.shotSelections ?? {}).filter(([shotId]) => retainedShots.has(shotId));
    db.run('DELETE FROM shots WHERE project_id = ?', [projectId]);
    normalized.forEach((shot, position) => insertShot(projectId, shot, position, approved ? 'approved' : 'draft'));
    writeProduction(projectId, {
      draftShots: null,
      ...(approved && { reviewedInputRevision: state.inputRevision ?? 0 }),
      ...(state.shotSelections && { shotSelections: selections.length ? Object.fromEntries(selections) : undefined }),
    });
    clearEditorDraft(projectId, 'shots');
    touch(projectId);
    return normalized;
  });
}

function writeProduction(projectId, patch) {
  const next = { ...production(projectId), ...patch };
  db.run(`INSERT INTO project_state(project_id, production) VALUES (?, ?)
    ON CONFLICT(project_id) DO UPDATE SET production = excluded.production`, [projectId, JSON.stringify(next)]);
  return next;
}

function invalidateAnalysis(state) {
  return { inputRevision: (state.inputRevision ?? 0) + 1, analysisShots: [] };
}

function saveInputs(projectId, templateId, inputs) {
  const state = production(projectId);
  if (isDeepStrictEqual(state.inputs, inputs)) {
    saveEditorDraft(projectId, 'inputs', null);
    return state;
  }
  const changed = analysisInputs[templateId]?.some(field => (state.inputs?.[field] || '') !== (inputs[field] || ''));
  return saveProduction(projectId, { inputs, ...(changed && invalidateAnalysis(state)) }, 'inputs');
}

function saveProduction(projectId, patch, editorSection) {
  const owner = projectRow(projectId);
  if (patch.draftShots) validateShotAssets(owner, patch.draftShots);
  return transaction(() => {
    const result = writeProduction(projectId, patch);
    if (editorSection) clearEditorDraft(projectId, editorSection);
    touch(projectId);
    return result;
  });
}

function clearEditorDraft(projectId, section) {
  db.run('DELETE FROM editor_drafts WHERE project_id = ? AND section = ?', [projectId, section]);
}

function writeEditorDraft(projectId, section, content) {
  db.run(`INSERT INTO editor_drafts (project_id, section, content) VALUES (?, ?, ?)
    ON CONFLICT(project_id, section) DO UPDATE SET content = excluded.content`, [projectId, section, content]);
}

function saveEditorDraft(projectId, section, draft) {
  const owner = editableProject(projectId);
  if (!editorSections.has(section)) throw new Error('无法保存未知的编辑草稿');
  const current = one('SELECT content FROM editor_drafts WHERE project_id = ? AND section = ?', [projectId, section]);
  if (draft === null) {
    if (current) transaction(() => clearEditorDraft(projectId, section));
    return;
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) !== (section === 'shots')) {
    throw new Error('编辑草稿格式无效');
  }
  if (section === 'shots') validateShotAssets(owner, draft);
  if (section === 'clip' && !one(`SELECT c.id FROM clips c JOIN tracks t ON t.id = c.track_id
    WHERE c.id = ? AND t.project_id = ?`, [draft.id ?? null, projectId])) return;
  const draftAssets = section === 'inputs' ? Object.keys(inputMediaKinds).map(key => draft[key])
    : section === 'clip' ? [draft.asset_id] : [];
  for (const assetId of draftAssets.filter(Boolean)) {
    if (!one('SELECT id FROM assets WHERE id = ? AND project_id = ?', [assetId, projectId])) {
      throw new Error('草稿引用的素材已移除，请重新选择');
    }
  }
  const content = JSON.stringify(draft);
  if (content === current?.content) return;
  transaction(() => writeEditorDraft(projectId, section, content));
}

function clearClipDraft(projectId, clipId) {
  db.run(`DELETE FROM editor_drafts WHERE project_id = ? AND section = 'clip'
    AND json_extract(content, '$.id') = ?`, [projectId, clipId]);
}

function clearRemovedClipDraft(projectId) {
  db.run(`DELETE FROM editor_drafts WHERE project_id = ? AND section = 'clip'
    AND NOT EXISTS (SELECT id FROM clips WHERE id = json_extract(editor_drafts.content, '$.id'))`, [projectId]);
}

function loadWorkflow(projectId) {
  const project = projectRow(projectId);
  const state = one('SELECT workflow FROM project_state WHERE project_id = ?', [projectId]);
  if (state?.workflow) return JSON.parse(state.workflow);
  // Keep the old per-directory file readable; all subsequent writes are per project.
  const legacy = path.join(project.dir, 'workflows', 'current.json');
  return fs.existsSync(legacy) ? JSON.parse(fs.readFileSync(legacy, 'utf8')) : null;
}

function saveWorkflow(projectId, workflow, mapping) {
  projectRow(projectId);
  transaction(() => {
    db.run(`INSERT INTO project_state(project_id, workflow) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET workflow = excluded.workflow`,
    [projectId, JSON.stringify({ workflow, mapping })]);
    writeProduction(projectId, { workflowDraft: null });
    clearEditorDraft(projectId, 'workflow');
    touch(projectId);
  });
}

function addJob(projectId, kind, detail) {
  return addJobs(projectId, kind, [detail])[0];
}

function addJobs(projectId, kind, details) {
  editableProject(projectId);
  return transaction(() => {
    const encode = encodeJobDetails();
    const jobs = details.map(detail => ({
      id: id(), project_id: projectId, kind, status: 'queued', prompt_id: null,
      detail: encode(kind, detail), created_at: now(),
    }));
    for (const job of jobs) db.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)', Object.values(job));
    return jobs;
  });
}

function updateJob(jobId, fields) {
  const keys = ['status', 'prompt_id', 'detail'].filter(key => key in fields);
  if (!keys.length) return;
  transaction(() => {
    const detail = fields.detail && JSON.parse(fields.detail);
    const storedDetail = detail?.workflow
      ? encodeJobDetails()(one('SELECT kind FROM jobs WHERE id = ?', [jobId])?.kind, detail) : fields.detail;
    db.run(`UPDATE jobs SET ${keys.map(key => key + ' = ?').join(',')} WHERE id = ?`,
      [...keys.map(key => key === 'detail' ? storedDetail : fields[key]), jobId]);
  });
}

function interruptJobs(jobs) {
  transaction(() => {
    for (const { id, detail } of jobs) {
      db.run("UPDATE jobs SET status = 'interrupted', detail = ? WHERE id = ?", [detail, id]);
    }
  });
}

function setSetting(key, value) {
  setSettings({ [key]: value });
}

function setSettings(entries) {
  transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      db.run(`INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)]);
    }
  });
}

function getSetting(key) {
  const entry = one('SELECT value FROM settings WHERE key = ?', [key]);
  return entry ? JSON.parse(entry.value) : null;
}

function projectTracks(projectId, includeDialogueWindows = false) {
  const tracks = all('SELECT * FROM tracks WHERE project_id = ? ORDER BY position', [projectId]).map(track => ({ ...track, clips: [] }));
  const indexed = new Map(tracks.map(track => [track.id, track]));
  const clips = all(`SELECT c.* FROM clips c JOIN tracks t ON t.id = c.track_id
    WHERE t.project_id = ? ${includeDialogueWindows ? '' : 'AND c.duration > 0'} ORDER BY t.position, c.start, c.rowid`, [projectId]);
  for (const { dialogue_window, ...clip } of clips) {
    if (includeDialogueWindows && dialogue_window) clip.dialogue_window = JSON.parse(dialogue_window);
    indexed.get(clip.track_id).clips.push(clip);
  }
  return tracks;
}

function hiddenDialogue(projectId) {
  return all(`SELECT c.linked_video_id AS videoId, c.track_id AS trackId FROM clips c JOIN tracks t ON t.id = c.track_id
    WHERE t.project_id = ? AND c.duration = 0 AND c.dialogue_window IS NOT NULL`, [projectId]);
}

function insertClipRecord(clip) {
  db.run(`INSERT INTO clips (id, track_id, asset_id, start, in_point, duration, volume, text, transition,
    linked_video_id, split_offset, split_duration, dialogue_window) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    clip.id, clip.track_id, clip.asset_id, clip.start, clip.in_point, clip.duration, clip.volume, clip.text, clip.transition,
    clip.linked_video_id ?? null, clip.split_offset ?? null, clip.split_duration ?? null,
    clip.dialogue_window == null ? null : JSON.stringify(clip.dialogue_window),
  ]);
}

function insertTimeline(projectId, tracks, useSavedPositions = false) {
  for (const [index, track] of tracks.entries()) {
    db.run('INSERT INTO tracks VALUES (?,?,?,?,?)', [track.id, projectId, track.kind, track.name, useSavedPositions ? track.position : index]);
    for (const clip of track.clips) insertClipRecord({ ...clip, track_id: track.id });
  }
}

function timelineCursor(projectId) {
  return one('SELECT position, action, tracks FROM timeline_history WHERE project_id = ? AND current = 1', [projectId]);
}

function timelineHistory(projectId, tracks = projectTracks(projectId, true)) {
  const current = timelineCursor(projectId);
  if (!current || current.tracks !== JSON.stringify(tracks)) return {};
  const previous = one('SELECT 1 FROM timeline_history WHERE project_id = ? AND position = ?', [projectId, current.position - 1]);
  const next = one('SELECT action FROM timeline_history WHERE project_id = ? AND position = ?', [projectId, current.position + 1]);
  return { undo: previous ? current.action : null, redo: next?.action ?? null };
}

function exportTimelineHistory(projectId, tracks) {
  const rows = all(`SELECT action, tracks, current FROM timeline_history WHERE project_id = ? ORDER BY position`, [projectId]);
  const cursor = rows.findIndex(row => row.current === 1);
  if (rows.length < 2 || rows[cursor]?.tracks !== JSON.stringify(tracks)) return undefined;
  return { cursor, entries: rows.map(row => ({ action: row.action, tracks: JSON.parse(row.tracks) })) };
}

function recordTimelineEdit(projectId, action, before, after) {
  let current = timelineCursor(projectId);
  if (current?.tracks !== before) {
    // Start from the real timeline if it was edited by an older app.
    db.run('DELETE FROM timeline_history WHERE project_id = ?', [projectId]);
    db.run('INSERT INTO timeline_history VALUES (?,0,NULL,?,1)', [projectId, before]);
    current = { position: 0 };
  }
  const position = current.position + 1;
  db.run('DELETE FROM timeline_history WHERE project_id = ? AND position >= ?', [projectId, position]);
  db.run('UPDATE timeline_history SET current = 0 WHERE project_id = ? AND current = 1', [projectId]);
  db.run('INSERT INTO timeline_history VALUES (?,?,?,?,1)', [projectId, position, action, after]);
  const snapshots = all(`SELECT position, length(CAST(tracks AS BLOB)) AS bytes FROM timeline_history
    WHERE project_id = ? ORDER BY position DESC`, [projectId]);
  let total = 0;
  const expired = snapshots.findIndex(({ bytes }, index) => {
    total += bytes;
    return index >= 2 && (index >= timelineHistoryLimit || total > 8 * 1024 ** 2);
  });
  if (expired >= 0) db.run('DELETE FROM timeline_history WHERE project_id = ? AND position <= ?', [projectId, snapshots[expired].position]);
}

function editTimeline(projectId, action, edit) {
  editableProject(projectId);
  const before = JSON.stringify(projectTracks(projectId, true));
  return transaction(() => {
    const result = edit();
    const after = JSON.stringify(projectTracks(projectId, true));
    if (before !== after) recordTimelineEdit(projectId, action, before, after);
    touch(projectId);
    return result;
  });
}

function stepTimeline(projectId, direction) {
  editableProject(projectId);
  if (direction !== 'undo' && direction !== 'redo') throw new Error('请选择撤销或重做');
  const current = timelineCursor(projectId);
  if (!current || current.tracks !== JSON.stringify(projectTracks(projectId, true))) {
    throw new Error('当前时间线没有可恢复的编辑记录');
  }
  const target = one('SELECT position, tracks FROM timeline_history WHERE project_id = ? AND position = ?',
    [projectId, current.position + (direction === 'undo' ? -1 : 1)]);
  if (!target) throw new Error(direction === 'undo' ? '没有可以撤销的时间线编辑' : '没有可以重做的时间线编辑');
  const tracks = JSON.parse(target.tracks);
  const sources = new Map(assets(projectId).map(asset => [asset.id, asset]));
  for (const clip of tracks.flatMap(track => track.clips)) {
    if (!clip.asset_id) continue;
    const asset = sources.get(clip.asset_id);
    if (!asset) throw new Error('该步骤使用的素材已被清理，无法恢复');
    const window = clip.dialogue_window;
    const rangeEnd = window ? window.inPoint + window.duration : clip.in_point + clip.duration;
    if (asset.duration && rangeEnd > asset.duration + 0.05) {
      throw new Error(`恢复后的片段超出素材「${asset.name}」的时长，请先定位原文件或选择更长的替换文件`);
    }
  }
  return transaction(() => {
    db.run('DELETE FROM clips WHERE track_id IN (SELECT id FROM tracks WHERE project_id = ?)', [projectId]);
    db.run('DELETE FROM tracks WHERE project_id = ?', [projectId]);
    // Insertion in display order also preserves compositing for clips with equal starts.
    insertTimeline(projectId, tracks, true);
    clearEditorDraft(projectId, 'clip');
    db.run('UPDATE timeline_history SET current = 0 WHERE project_id = ? AND current = 1', [projectId]);
    const restored = projectTracks(projectId, true);
    db.run('UPDATE timeline_history SET current = 1, tracks = ? WHERE project_id = ? AND position = ?',
      [JSON.stringify(restored), projectId, target.position]);
    touch(projectId);
    return timelineHistory(projectId, restored);
  });
}

function insertTrack(projectId, kind, name) {
  if (!trackKinds.includes(kind)) throw new Error('无效的轨道类型');
  const { position } = one('SELECT coalesce(max(position), -1) + 1 AS position FROM tracks WHERE project_id = ?', [projectId]);
  const track = { id: id(), project_id: projectId, kind, name: String(name || kind), position };
  db.run('INSERT INTO tracks VALUES (?,?,?,?,?)', Object.values(track));
  return track;
}

function addTrack(projectId, kind, name) {
  return editTimeline(projectId, '添加轨道', () => insertTrack(projectId, kind, name));
}

function projectTrack(projectId, trackId) {
  editableProject(projectId);
  const track = one('SELECT * FROM tracks WHERE project_id = ? AND id = ?', [projectId, trackId]);
  if (!track) throw new Error('当前项目中找不到该轨道');
  return track;
}

function renameTrack(projectId, trackId, name) {
  const track = projectTrack(projectId, trackId);
  if (typeof name !== 'string' || !name.trim()) throw new Error('请输入轨道名称');
  const next = name.trim();
  if (next === track.name) return;
  editTimeline(projectId, '重命名轨道', () => {
    db.run('UPDATE tracks SET name = ? WHERE id = ?', [next, trackId]);
  });
}

function moveTrack(projectId, trackId, offset) {
  const track = projectTrack(projectId, trackId);
  if (offset !== -1 && offset !== 1) throw new Error('无效的轨道移动方向');
  const tracks = all('SELECT id, position FROM tracks WHERE project_id = ? ORDER BY position', [projectId]);
  const target = tracks[tracks.findIndex(item => item.id === trackId) + offset];
  if (!target) return;
  editTimeline(projectId, '移动轨道', () => {
    db.run('UPDATE tracks SET position = ? WHERE id = ?', [target.position, trackId]);
    db.run('UPDATE tracks SET position = ? WHERE id = ?', [track.position, target.id]);
  });
}

function deleteTrack(projectId, trackId) {
  const track = projectTrack(projectId, trackId);
  editTimeline(projectId, '删除轨道', () => {
    if (track.kind === 'video') {
      db.run('DELETE FROM clips WHERE linked_video_id IN (SELECT id FROM clips WHERE track_id = ?)', [trackId]);
    }
    db.run('DELETE FROM clips WHERE track_id = ?', [trackId]);
    db.run('DELETE FROM tracks WHERE id = ?', [trackId]);
    clearRemovedClipDraft(projectId);
  });
}

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}必须介于 ${min} 和 ${max} 之间`);
  }
  return value;
}

function clipValues(track, clip, options) {
  const isSubtitle = track.kind === 'subtitle';
  const asset = isSubtitle ? null : inputAsset(track.project_id, clip.asset_id, track.kind === 'audio' ? ['audio'] : ['image', 'video'], options);
  const start = number(clip.start ?? 0, '时间线起点', 0, 86400);
  const inPoint = number(clip.in_point ?? 0, '素材入点', 0, 86400);
  const duration = number(clip.duration ?? (asset?.duration || 4), '片段时长', 0.04, 86400);
  if (asset?.duration && inPoint + duration > asset.duration + 0.05) throw new Error('片段超出了素材的有效时长');
  const transition = clip.transition ?? 'none';
  if (!['none', 'fade'].includes(transition)) throw new Error('不支持该转场');
  return {
    track_id: track.id, asset_id: asset?.id ?? null, start, in_point: isSubtitle || asset?.kind === 'image' ? 0 : inPoint,
    duration, volume: number(clip.volume ?? 1, '音量', 0, 4),
    text: isSubtitle ? String(clip.text || '') : '', transition: track.kind === 'video' ? transition : 'none',
  };
}

function addClip(trackId, input) {
  const track = one('SELECT * FROM tracks WHERE id = ?', [trackId]);
  if (!track) throw new Error('轨道不存在');
  if (projectRow(track.project_id).template_id === 'enhance') {
    requireEnhancementReview(project(track.project_id, { includeWorkflow: false }).assets.find(asset => asset.id === input.asset_id));
  }
  const tail = one('SELECT coalesce(max(start + duration), 0) AS tail FROM clips WHERE track_id = ? AND duration > 0', [trackId]).tail;
  return editTimeline(track.project_id, '添加片段', () => insertClip(track, { ...input, start: input.start ?? tail }));
}

function insertClip(track, input, linkedVideoId = null) {
  const clip = { id: id(), ...clipValues(track, input), linked_video_id: linkedVideoId, split_offset: null, split_duration: null };
  insertClipRecord(clip);
  return clip;
}

function storyboardOptions(projectId) {
  editableProject(projectId);
  const current = project(projectId);
  const shots = current.shots.filter(shot => shot.status === 'approved');
  const selections = new Map(Object.entries(current.production.shotSelections ?? {}));
  const groups = new Map(shots.map(shot => [shot.id, {
    shot, selectedAssetId: selections.get(shot.id) ?? null, candidates: [], timelineClips: [],
  }]));
  const state = { tracks: current.tracks, assets: current.assets, groups, clipDraftId: current.editorDrafts.clip?.id };
  if (current.template_id === 'enhance' || !shots.length || hasShotDraft(current)) {
    return { ...state, error: '请先确认当前分镜再生成粗剪' };
  }
  if ((current.production.reviewedInputRevision ?? 0) !== (current.production.inputRevision ?? 0)) {
    return { ...state, error: '分析输入已变更，请重新确认分镜后再生成粗剪' };
  }
  let bundle, template;
  try {
    bundle = loadWorkflow(projectId);
    if (!bundle) return { ...state, error: '请先保存用于生成镜头的工作流' };
    template = resolveTemplate(current);
  } catch (error) {
    return { ...state, error: error.message };
  }
  const shotGroups = [...groups.values()];
  const shotBindings = ['prompt', 'title', 'duration', 'dialogue', 'frameCount'].filter(field => Object.hasOwn(bundle.mapping, field));
  for (const group of shotGroups) {
    try {
      group.inputs = generationInputs(current, template, bundle.mapping, group.shot);
      group.values = shotValues(group.shot, bundle.workflow, bundle.mapping);
    } catch (error) {
      group.error = error.message;
    }
  }
  const commonError = shotGroups[0].error;
  if (commonError && shotGroups.every(group => group.error === commonError)) {
    for (const group of shotGroups) delete group.error;
    return { ...state, error: commonError };
  }
  const workflowMatches = new Map();
  const matchesBundle = specification => isDeepStrictEqual(specification.workflow, bundle.workflow) &&
    isDeepStrictEqual(specification.mapping, bundle.mapping);
  const sameWorkflow = detail => {
    const reference = detail.workflowRef;
    if (!reference) return matchesBundle(detail);
    if (!workflowMatches.has(reference)) workflowMatches.set(reference, matchesBundle(jobWorkflow(reference)));
    return workflowMatches.get(reference);
  };
  const sameOutput = (detail, { assetInputs, assetRevisions }) => {
    const revisions = detail.assetRevisions ?? Object.fromEntries(Object.keys(detail.assetInputs || {}).map(role => [role, 0]));
    return sameWorkflow(detail) && isDeepStrictEqual(detail.assetInputs, assetInputs) && isDeepStrictEqual(revisions, assetRevisions);
  };
  const assetsById = new Map(current.assets.map(asset => [asset.id, asset]));
  const groupsByAsset = new Map();
  for (const job of current.jobs) {
    if (job.kind !== 'comfy' || job.status !== 'done') continue;
    const detail = JSON.parse(job.detail);
    if (!detail.shotId || !detail.values || !Array.isArray(detail.assets)) continue;
    const group = groups.get(detail.shotId);
    if (!group) continue;
    const recorded = detail.assets.map(assetId => assetsById.get(assetId)).filter(asset =>
      asset?.origin === 'comfy' && asset.job_id === job.id);
    for (const asset of recorded) groupsByAsset.set(asset.id, group);
    if (group.error || !group.inputs || !sameOutput(detail, group.inputs) ||
        shotBindings.some(field => detail.values[field] !== group.values[field])) continue;
    const candidates = recorded.filter(asset => asset.exists &&
      (!detail.outputKinds?.length || detail.outputKinds.includes(asset.kind)) &&
      (asset.generated_sha256 ? asset.generated_sha256 === asset.sha256 : asset.revision === 0));
    for (const kind of ['video', 'image']) {
      for (const asset of candidates.filter(item => item.kind === kind)) {
        group.candidates.push({ asset, seed: detail.values.seed });
      }
    }
  }
  for (const track of current.tracks.filter(track => track.kind === 'video')) {
    for (const clip of track.clips) {
      const group = groupsByAsset.get(clip.asset_id);
      if (group) group.timelineClips.push({ clip, kind: assetsById.get(clip.asset_id).kind });
    }
  }
  return state;
}

function storyboardResults(projectId) {
  const { groups, error } = storyboardOptions(projectId);
  return {
    error,
    shots: [...groups.values()].map(({ shot, selectedAssetId, candidates, timelineClips, error }) => ({
      shotId: shot.id, selectedAssetId,
      ...(error && { error }),
      timelineClipIds: timelineClips.map(({ clip }) => clip.id),
      candidates: candidates.map(({ asset, seed }) => ({ assetId: asset.id, seed })),
    })),
  };
}

async function chooseShotResult(projectId, shotId, selectedAssetId) {
  const before = storyboardOptions(projectId);
  const group = before.groups.get(shotId);
  if (!group) throw new Error('请选择当前项目的已确认分镜');
  if (selectedAssetId !== null) {
    if (before.error || group.error) throw new Error(before.error || group.error);
    const selected = group.candidates.find(item => item.asset.id === selectedAssetId);
    if (!selected) throw new Error('所选版本已不可用，请选择当前分镜的其他生成结果');
    await assetFiles.requireAssetFile(selected.asset);
    const next = storyboardOptions(projectId);
    const latest = next.groups.get(shotId);
    if (next.error || !latest || latest.error || latest.selectedAssetId !== group.selectedAssetId ||
        !isDeepStrictEqual(latest.candidates.find(item => item.asset.id === selectedAssetId), selected)) {
      throw new Error('分镜、素材或已选版本发生变更，请刷新后重试');
    }
  }
  const entries = new Map(Object.entries(production(projectId).shotSelections ?? {}));
  if (selectedAssetId === null) entries.delete(shotId);
  else entries.set(shotId, selectedAssetId);
  saveProduction(projectId, { shotSelections: entries.size ? Object.fromEntries(entries) : undefined });
}

function shotReplacementPlan(projectId, shotId, assetId, clipId) {
  const state = storyboardOptions(projectId);
  if (state.error) throw new Error(state.error);
  const group = state.groups.get(shotId);
  if (!group) throw new Error('请选择当前项目的已确认分镜');
  if (group.error) throw new Error(group.error);
  const candidate = group.candidates.find(({ asset }) => asset.id === assetId)?.asset;
  if (!candidate) throw new Error('所选版本已不可用，请重新选择生成结果');
  const clips = group.timelineClips.filter(({ clip }) => (clipId == null || clip.id === clipId) && clip.asset_id !== assetId);
  if (!clips.length) throw new Error('没有可以替换的同分镜片段，请刷新时间线');
  if (clips.some(({ clip }) => clip.id === state.clipDraftId)) throw new Error('请先保存或放弃待替换片段的修改');
  if (clips.some(({ kind }) => kind !== candidate.kind)) {
    throw new Error('请为待替换片段选择同类型的生成版本');
  }
  if (candidate.kind === 'video') {
    const usedUntil = Math.max(...clips.map(({ clip }) => clip.in_point + clip.duration));
    // Media metadata from FFmpeg rounds duration to centiseconds.
    if (!candidate.duration || usedUntil > candidate.duration + 0.005001) {
      throw new Error(`片段使用到素材的 ${usedUntil.toFixed(3)} 秒，请选择能覆盖该剪辑范围的视频版本`);
    }
  }
  return { candidate, clips };
}

async function replaceShotVersion(projectId, shotId, assetId, clipId) {
  const planned = shotReplacementPlan(projectId, shotId, assetId, clipId);
  await assetFiles.requireAssetFile(planned.candidate);
  const current = shotReplacementPlan(projectId, shotId, assetId, clipId);
  if (!isDeepStrictEqual(current, planned)) throw new Error('分镜、素材或剪辑点已变更，请刷新后重新替换');
  return editTimeline(projectId, '替换镜头版本', () => {
    for (const { clip } of current.clips) db.run('UPDATE clips SET asset_id = ? WHERE id = ?', [assetId, clip.id]);
    return current.clips.length;
  });
}

function storyboardPlan(projectId) {
  const { tracks, assets, groups, error } = storyboardOptions(projectId);
  if (error) throw new Error(error);
  const shots = [...groups.values()].map(({ shot, selectedAssetId, candidates, error }) => {
    if (error) throw new Error(`分镜「${shot.title}」：${error}`);
    const chosen = selectedAssetId ? candidates.find(item => item.asset.id === selectedAssetId) : candidates[0];
    if (selectedAssetId && !chosen) throw new Error(`分镜「${shot.title}」已选版本不可用，请重新选择或恢复自动选择`);
    return { shot, asset: chosen?.asset };
  });
  const missing = shots.filter(item => !item.asset);
  if (missing.length) {
    const names = missing.slice(0, 5).map(({ shot }) => shot.title).join('、');
    throw new Error(`还有 ${missing.length} 个分镜没有对应的可用结果：${names}`);
  }
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  return { tracks, shots: shots.map(({ shot, asset }) => {
    const duration = asset.duration ? Math.min(asset.duration, shot.duration) : shot.duration;
    const voice = assetsById.get(shot.dialogue_audio_id);
    if (shot.dialogue_audio_id) {
      if (!voice?.exists) throw new Error(`分镜「${shot.title}」的配音缺失，请重新定位或选择音频`);
      if (voice.kind !== 'audio' || !Number.isFinite(voice.duration) || voice.duration < 0.04) {
        throw new Error(`分镜「${shot.title}」的配音时长不可用，请换用可读取的音频文件`);
      }
      if (voice.duration > duration + 0.005001) {
        throw new Error(`分镜「${shot.title}」的配音有 ${voice.duration.toFixed(2)} 秒，镜头仅有 ${duration.toFixed(2)} 秒。请选择更短的配音，或为较长的分镜重新生成镜头`);
      }
    }
    return { shot, asset, voice, duration };
  }) };
}

function appendStoryboard(projectId) {
  const pending = pendingStoryboards.get(projectId);
  if (pending) return pending;
  const operation = appendStoryboardOnce(projectId).finally(() => pendingStoryboards.delete(projectId));
  pendingStoryboards.set(projectId, operation);
  return operation;
}

async function appendStoryboardOnce(projectId) {
  const planned = storyboardPlan(projectId).shots;
  for (const { asset, voice } of planned) {
    await assetFiles.requireAssetFile(asset);
    if (voice) await assetFiles.requireAssetFile(voice);
  }
  const { tracks, shots } = storyboardPlan(projectId);
  if (!isDeepStrictEqual(planned, shots)) throw new Error('粗剪所用的分镜或素材已变更，请重新追加');

  return editTimeline(projectId, '追加粗剪', () => {
    const video = tracks.find(track => track.kind === 'video') || insertTrack(projectId, 'video', '视频 1');
    const captions = shots.some(({ shot }) => shot.dialogue.trim())
      ? tracks.find(track => track.kind === 'subtitle') || insertTrack(projectId, 'subtitle', '台词字幕')
      : null;
    const dialogue = shots.some(({ voice }) => voice)
      ? tracks.find(track => track.kind === 'audio' && track.name === '台词配音') || insertTrack(projectId, 'audio', '台词配音')
      : null;
    const { tail } = one(`SELECT coalesce(max(c.start + c.duration), 0) AS tail FROM clips c
      JOIN tracks t ON t.id = c.track_id WHERE t.project_id = ? AND c.duration > 0`, [projectId]);
    let start = tail;
    for (const { shot, asset, voice, duration } of shots) {
      const clip = insertClip(video, { asset_id: asset.id, start, duration, volume: voice ? 0 : 1 });
      if (captions && shot.dialogue.trim()) insertClip(captions, { text: shot.dialogue, start, duration }, clip.id);
      if (voice) insertClip(dialogue, { asset_id: voice.id, start, duration: Math.min(voice.duration, duration) }, clip.id);
      start += duration;
    }
    return { clips: shots.length, start: tail, end: start };
  });
}

function linkedClips(videoId) {
  return all(`SELECT c.*, t.kind FROM clips c JOIN tracks t ON t.id = c.track_id
    WHERE c.linked_video_id = ? ORDER BY c.rowid`, [videoId]);
}

const timelinePrecision = value => Math.round(value * 1e9) / 1e9;

function dialogueWindow(audio, video) {
  return audio.dialogue_window ? JSON.parse(audio.dialogue_window) : {
    offset: timelinePrecision(audio.start - video.start + video.in_point),
    inPoint: audio.in_point,
    duration: audio.duration,
  };
}

function dialogueIntersection(window, video) {
  const start = Math.max(window.offset, video.in_point);
  const end = Math.min(window.offset + window.duration, video.in_point + video.duration);
  return { offset: start, duration: timelinePrecision(end - start) };
}

function placeDialogue(window, video) {
  const { offset, duration } = dialogueIntersection(window, video);
  const audible = duration >= 0.04;
  const fullyVisible = audible && duration === window.duration && offset === window.offset;
  return {
    start: number(timelinePrecision(video.start + (audible ? offset - video.in_point : 0)), '关联片段起点', 0, 86400),
    in_point: audible ? timelinePrecision(window.inPoint + offset - window.offset) : window.inPoint,
    duration: audible ? duration : 0,
    dialogue_window: fullyVisible ? null : window,
    linked_video_id: video.id,
  };
}

function saveDialogue(clipId, { start, in_point, duration, dialogue_window, linked_video_id }) {
  db.run('UPDATE clips SET start = ?, in_point = ?, duration = ?, dialogue_window = ?, linked_video_id = ? WHERE id = ?', [
    start, in_point, duration, dialogue_window === null ? null : JSON.stringify(dialogue_window), linked_video_id, clipId,
  ]);
}

function updateLinkedClips(projectId, current, next, timingChanged) {
  for (const linked of linkedClips(current.id)) {
    if (linked.kind === 'audio') {
      saveDialogue(linked.id, placeDialogue(dialogueWindow(linked, current), { ...next, id: current.id }));
    } else if (timingChanged) {
      db.run('UPDATE clips SET start = ?, duration = ? WHERE id = ?', [next.start, next.duration, linked.id]);
    } else continue;
    clearClipDraft(projectId, linked.id);
  }
}

function updateClip(clipId, patch) {
  const current = one('SELECT * FROM clips WHERE id = ? AND duration > 0', [clipId]);
  if (!current) throw new Error('片段不存在');
  const originalTrack = one('SELECT * FROM tracks WHERE id = ?', [current.track_id]);
  const track = one('SELECT * FROM tracks WHERE id = ?', [patch.track_id ?? current.track_id]);
  if (!track || track.project_id !== originalTrack.project_id || track.kind !== originalTrack.kind) {
    throw new Error('只能移动到同项目的同类轨道');
  }
  const input = { ...current, ...patch };
  if (input.asset_id !== current.asset_id && projectRow(track.project_id).template_id === 'enhance') {
    requireEnhancementReview(project(track.project_id, { includeWorkflow: false }).assets.find(asset => asset.id === input.asset_id));
  }
  const next = clipValues(track, input, { allowMissing: input.asset_id === current.asset_id });
  const timingChanged = next.start !== current.start || next.duration !== current.duration;
  const detach = patch.detachLink === true || patch.detachCaption === true;
  next.linked_video_id = detach || timingChanged ? null : current.linked_video_id;
  const retainSplit = next.transition === current.transition && next.duration === current.duration &&
    next.in_point === current.in_point && next.asset_id === current.asset_id;
  next.split_offset = retainSplit ? current.split_offset : null;
  next.split_duration = retainSplit ? current.split_duration : null;
  const action = detach ? (track.kind === 'audio' ? '解除配音关联' : '解除字幕关联') : '修改片段';
  editTimeline(track.project_id, action, () => {
    db.run(`UPDATE clips SET ${Object.keys(next).map(key => key + ' = ?').join(',')} WHERE id = ?`, [...Object.values(next), clipId]);
    if (current.dialogue_window && (!next.linked_video_id || next.in_point !== current.in_point || next.asset_id !== current.asset_id)) {
      db.run('UPDATE clips SET dialogue_window = NULL WHERE id = ?', [clipId]);
    }
    if (track.kind === 'video' && (timingChanged || next.in_point !== current.in_point)) {
      updateLinkedClips(track.project_id, current, next, timingChanged);
    }
    clearClipDraft(track.project_id, clipId);
  });
  return { id: clipId, ...next };
}

function splitDialogue(audio, video, left, right) {
  const window = dialogueWindow(audio, video);
  const cut = timelinePrecision(video.in_point + left.duration);
  const before = Math.min(window.duration, timelinePrecision(cut - window.offset));
  const after = timelinePrecision(window.duration - Math.max(0, before));
  const rightOffset = timelinePrecision(Math.max(cut, window.offset) - cut + right.in_point);
  const pieces = [
    ...(before > 0 ? [[{ ...window, duration: before }, left]] : []),
    ...(after > 0 ? [[{
      offset: rightOffset, inPoint: timelinePrecision(window.inPoint + Math.max(0, before)), duration: after,
    }, right]] : []),
  ];
  if (audio.duration > 0 && pieces.some(([part, video]) => {
    const { duration } = dialogueIntersection(part, video);
    return duration > 0 && duration < 0.04;
  })) throw new Error('关联配音在拆分位置过短，请先调整拆分位置或解除配音关联');

  const [first, second] = pieces.map(([part, video]) => placeDialogue(part, video));
  saveDialogue(audio.id, first);
  if (second) insertClipRecord({ ...audio, ...second, id: id() });
}

function splitClip(clipId, time, fps) {
  const clip = one('SELECT * FROM clips WHERE id = ? AND duration > 0', [clipId]);
  if (!clip) throw new Error('片段不存在');
  if (clip.linked_video_id) throw new Error('请拆分关联的视频片段');
  const track = one('SELECT * FROM tracks WHERE id = ?', [clip.track_id]);
  const snap = timelinePrecision;
  const point = Math.round(number(time, '拆分位置', 0, 86400) * fps) / fps;
  const leftDuration = snap(point - clip.start);
  const rightDuration = snap(clip.duration - leftDuration);
  if (leftDuration < 0.04 || rightDuration < 0.04) throw new Error('请将播放头移到片段内，拆分后两段至少各保留 0.04 秒');
  const asset = clip.asset_id ? assetRecord(clip.asset_id) : null;
  const inPoint = asset && asset.kind !== 'image' ? snap(clip.in_point + leftDuration) : 0;
  const values = clipValues(track, { ...clip, start: point, in_point: inPoint, duration: rightDuration }, { allowMissing: true });
  const originalDuration = track.kind === 'video' ? clip.split_duration ?? clip.duration : null;
  const originalOffset = originalDuration === null ? null : clip.split_offset ?? 0;
  const right = {
    id: id(), ...values, linked_video_id: null, split_duration: originalDuration,
    split_offset: originalOffset === null ? null : snap(originalOffset + leftDuration),
  };
  return editTimeline(track.project_id, '拆分片段', () => {
    db.run('UPDATE clips SET duration = ?, split_offset = ?, split_duration = ? WHERE id = ?',
      [leftDuration, originalOffset, originalDuration, clipId]);
    insertClipRecord(right);
    for (const linked of linkedClips(clipId)) {
      if (linked.kind === 'audio') {
        splitDialogue(linked, clip, { ...clip, duration: leftDuration }, right);
      } else {
        const end = snap(linked.start + linked.duration);
        if (end <= point) continue;
        if (linked.start >= point) {
          db.run('UPDATE clips SET linked_video_id = ? WHERE id = ?', [right.id, linked.id]);
        } else {
          const before = snap(point - linked.start);
          const after = snap(end - point);
          if (before < 0.04 || after < 0.04) throw new Error('关联字幕在拆分位置过短，请先调整拆分位置或解除字幕关联');
          db.run('UPDATE clips SET duration = ? WHERE id = ?', [before, linked.id]);
          insertClipRecord({ ...linked, id: id(), start: point, duration: after, linked_video_id: right.id });
        }
      }
      clearClipDraft(track.project_id, linked.id);
    }
    clearClipDraft(track.project_id, clipId);
    return right;
  });
}

function reorderClip(clipId, targetId, placement) {
  if (!['before', 'after'].includes(placement)) throw new Error('无效的排序位置');
  const current = one('SELECT track_id FROM clips WHERE id = ? AND duration > 0', [clipId]);
  if (!current) throw new Error('片段不存在');
  const track = one('SELECT * FROM tracks WHERE id = ?', [current.track_id]);
  const clips = all('SELECT * FROM clips WHERE track_id = ? AND duration > 0 ORDER BY start, rowid', [track.id]);
  const from = clips.findIndex(clip => clip.id === clipId);
  const to = clips.findIndex(clip => clip.id === targetId);
  if (to < 0) throw new Error('片段只能在同一条轨道上插入排序');
  if (from === to || placement === 'before' && from === to - 1 || placement === 'after' && from === to + 1) return;
  const range = clips.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (range.some(clip => clip.linked_video_id)) throw new Error('请移动或排序关联的视频片段');
  const gaps = range.slice(1).map((clip, index) => clip.start - (range[index].start + range[index].duration));
  if (gaps.some(gap => gap < -0.000001)) throw new Error('排序范围内有重叠片段，请先错开或自由拖动');
  const reordered = range.filter(clip => clip.id !== clipId);
  const insertAt = reordered.findIndex(clip => clip.id === targetId) + Number(placement === 'after');
  reordered.splice(insertAt, 0, clips[from]);
  editTimeline(track.project_id, '排序片段', () => {
    let start = range[0].start;
    for (const [index, clip] of reordered.entries()) {
      db.run('UPDATE clips SET start = ? WHERE id = ?', [number(start, '时间线起点', 0, 86400), clip.id]);
      if (track.kind === 'video') db.run('UPDATE clips SET start = start + ? WHERE linked_video_id = ?', [start - clip.start, clip.id]);
      start += clip.duration + Math.max(0, gaps[index] ?? 0);
    }
  });
}

function deleteClip(clipId) {
  const owner = one(`SELECT t.project_id FROM clips c JOIN tracks t ON t.id = c.track_id WHERE c.id = ?`, [clipId]);
  if (!owner) return;
  editTimeline(owner.project_id, '删除片段', () => {
    db.run('DELETE FROM clips WHERE id = ? OR linked_video_id = ?', [clipId, clipId]);
    clearRemovedClipDraft(owner.project_id);
  });
}

module.exports = {
  init, run, all, one, id, now, createProject, restoreProject, relocateProject, project, projectRow, listProjects, editableProject,
  renameProject, archiveProject, unarchiveProject, assets, assetRecord, inputAsset, addMedia, relinkAsset,
  assetCleanupPlan, removeUnusedAssets, pendingAssetTrash, stageAssetTrash, finishAssetTrash,
  approveEnhancement, requireEnhancementReview,
  normalizeShots, setShots, production, saveInputs, saveProduction, saveEditorDraft, loadWorkflow, saveWorkflow, jobWorkflow,
  addJob, addJobs, updateJob, setSetting, setSettings,
  getSetting, projectTracks, hiddenDialogue, addTrack, renameTrack, moveTrack, deleteTrack, addClip, appendStoryboard, storyboardResults, chooseShotResult,
  replaceShotVersion, updateClip, splitClip, reorderClip, deleteClip, timelineHistory, exportTimelineHistory, timelineHistoryLimit,
  stepTimeline, interruptJobs,
};
