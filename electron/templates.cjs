const { randomInt } = require('node:crypto');

const shotSchema = 'shots 为 {title:string,prompt:string,duration:number,dialogue:string,scene:string,characters:string[]} 的数组。scene 使用对应的场次标题，characters 仅列出该镜头出现的角色。画面提示词应独立可执行，时长以秒计。';
const analysisSchema = '返回 JSON 对象：{summary:string,characters:string[],scenes:[{title:string,description:string}],shots:[]}。' + shotSchema;
const analysisInputs = {
  drama: ['script', 'referenceVideo'],
  fashion: ['product', 'sellingPoints', 'productImage'],
};
const generationAssetKinds = { productImage: 'image', referenceImage: 'image', sourceVideo: 'video' };
const inputMediaKinds = { ...generationAssetKinds, referenceVideo: 'video' };
const inputFields = new Set(['script', 'product', 'sellingPoints', ...Object.keys(inputMediaKinds)]);
const stageNames = new Set(['input', 'analyze', 'review', 'generate', 'edit', 'export']);
const primaryAssetField = { drama: 'referenceImage', fashion: 'productImage', enhance: 'sourceVideo' };
const maxLtxShotSeconds = 8;
const shotDuration = { min: 0.1, max: 3600, default: 4 };

const templates = [
  {
    id: 'drama', version: 3, name: '短剧制作',
    description: '从文字剧本或参考视频拆解场次，审核分镜后生成镜头并剪辑成片。',
    fields: ['script', 'referenceVideo', 'referenceImage'],
    stages: ['input', 'analyze', 'review', 'generate', 'edit', 'export'],
    analysisPrompt: '分析短剧的剧情、人物、场次和镜头。参考视频有检测时间码时，场次说明应引用相应时间范围。' + analysisSchema,
    requiresReview: true, outputKinds: ['image', 'video'],
  },
  {
    id: 'fashion', version: 3, name: '商品穿搭',
    description: '选择商品图片，填写商品和卖点，生成穿搭分镜与展示镜头。',
    fields: ['product', 'sellingPoints', 'productImage'],
    stages: ['input', 'analyze', 'review', 'generate', 'edit', 'export'],
    analysisPrompt: '为商品制定穿搭视频脚本，包含开场、搭配和卖点展示。保持商品实际属性。' + analysisSchema,
    requiresReview: true, outputKinds: ['image', 'video'],
  },
  {
    id: 'enhance', version: 2, name: '画质增强',
    description: '将源视频交给增强工作流，对比处理前后画面，再剪辑或导出。',
    fields: ['sourceVideo'], stages: ['input', 'generate', 'review', 'edit', 'export'],
    analysisPrompt: '', requiresReview: true, outputKinds: ['video'],
  },
];

function resolveTemplate(project) {
  const builtin = templates.find(item => item.id === project.template_id);
  if (!builtin) throw new Error('项目模板不存在');
  const snapshot = JSON.parse(project.template_snapshot);
  if (!Number.isInteger(snapshot?.version) || snapshot.version < 1) throw new Error('项目模板版本无效');
  // Version 1 predates the current input and output contract. Preserve the
  // metadata it did save and fill only absent properties from the built-in.
  const template = snapshot.version === 1 ? { ...builtin, ...snapshot } : snapshot;
  if (template.id !== builtin.id || ['name', 'description', 'analysisPrompt'].some(key => typeof template[key] !== 'string') ||
      !Array.isArray(template.fields) || template.fields.some(field => !inputFields.has(field)) ||
      new Set(template.fields).size !== template.fields.length ||
      !Array.isArray(template.stages) || template.stages.some(stage => !stageNames.has(stage)) ||
      !Array.isArray(template.outputKinds) || template.outputKinds.some(kind => !['image', 'video', 'audio'].includes(kind))) {
    throw new Error('项目模板信息不完整或包含不支持的字段');
  }
  return template;
}

function videoFrameCount(workflow, binding, seconds) {
  const target = workflow[binding.node];
  if (binding.input !== 'length' || !['EmptyLTXVLatentVideo', 'LTXVImgToVideo'].includes(target?.class_type)) {
    throw new Error('frameCount 需要绑定到 LTX Video 节点的 length 输入');
  }
  const encoders = Object.values(workflow).filter(node => node.class_type === 'CreateVideo');
  const fps = encoders[0]?.inputs.fps;
  if (encoders.length !== 1 || !Number.isFinite(fps) || fps < 1 || fps > 120) {
    throw new Error('使用 frameCount 时，请在唯一的 CreateVideo 节点中填写固定帧率');
  }
  validateLtxShotDuration(seconds);
  // LTX accepts frame counts of the form 8n+1. Round up so the requested
  // duration can be trimmed exactly on the editing timeline.
  return Math.max(9, 1 + 8 * Math.ceil((seconds * fps - 1) / 8));
}

function validateLtxShotDuration(seconds) {
  if (seconds > maxLtxShotSeconds) throw new Error(`LTX 动态工作流的单镜头时长上限为 ${maxLtxShotSeconds} 秒，请拆分或缩短镜头`);
}

function shotValues(shot, workflow, mapping) {
  const context = [];
  if (shot.scene) context.push('Scene: ' + shot.scene);
  if (shot.characters?.length) context.push('Characters in this shot: ' + shot.characters.join(', '));
  const values = {
    title: shot.title, prompt: [shot.prompt, ...context].join('\n'),
    duration: shot.duration, dialogue: shot.dialogue,
  };
  if (mapping.frameCount) values.frameCount = videoFrameCount(workflow, mapping.frameCount, shot.duration);
  return values;
}

function unsupportedAssetBinding(template, mapping) {
  return Object.keys(mapping).map(key => key === 'asset' ? primaryAssetField[template.id] : key)
    .find(field => Object.hasOwn(generationAssetKinds, field) && !template.fields.includes(field));
}

function workflowSeed(workflow, { node, input }) {
  const seed = workflow?.[node]?.inputs?.[input];
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('种子映射需要指向一个非负整数输入');
  return seed;
}

function shotSeedBinding(workflow, mapping) {
  if (mapping.seed) return mapping.seed;
  const fields = { KSampler: 'seed', KSamplerAdvanced: 'noise_seed', SamplerCustom: 'noise_seed', RandomNoise: 'noise_seed' };
  const candidates = Object.entries(workflow).flatMap(([node, step]) => {
    const input = fields[step.class_type];
    const seed = step.inputs[input];
    return Object.hasOwn(fields, step.class_type) && Number.isSafeInteger(seed) && seed >= 0 &&
      !Object.values(mapping).some(target => String(target.node) === node && target.input === input) ? [{ node, input }] : [];
  });
  if (candidates.length !== 1) throw new Error('无法确定生成种子。请在工作流映射中指定 seed 对应的整数输入');
  return candidates[0];
}

function validateTemplateMapping(template, mapping, workflow) {
  if (!template.stages.includes('generate')) throw new Error('此模板版本不包含生成阶段');
  const expectedBinding = template.id === 'enhance' ? 'sourceVideo' : 'prompt';
  if (!mapping[expectedBinding] && !(expectedBinding === 'sourceVideo' && mapping.asset)) {
    throw new Error(`工作流必须绑定 ${expectedBinding} 输入`);
  }
  if (template.id === 'fashion' && !mapping.productImage && !mapping.asset) {
    throw new Error('商品工作流必须绑定 productImage');
  }
  const unsupported = unsupportedAssetBinding(template, mapping);
  if (unsupported) throw new Error(`此模板版本不包含 ${unsupported} 输入，请更换工作流映射`);
  if (mapping.frameCount && !template.outputKinds.includes('video')) throw new Error('此模板版本不支持动态镜头输出');
  if (mapping.frameCount && workflow) videoFrameCount(workflow, mapping.frameCount, shotDuration.default);
  if (mapping.seed && workflow) workflowSeed(workflow, mapping.seed);
}

function supportsShotReferences(template) {
  return template.id === 'drama' && template.fields.includes('referenceImage');
}

function generationInputs(project, template, mapping, shot) {
  validateTemplateMapping(template, mapping);
  const inputs = project.production.inputs || {};
  const reference = supportsShotReferences(template) ? shot?.reference_image_id : null;
  if (reference && !mapping.referenceImage && !mapping.asset) {
    throw new Error('已指定镜头参考图，请使用参考图工作流或绑定 referenceImage');
  }
  const roles = Object.fromEntries(Object.keys(generationAssetKinds).map(field => [field, field]));
  roles.asset = primaryAssetField[template.id];
  const assetInputs = {};
  const assetRevisions = {};
  for (const [name, field] of Object.entries(roles)) {
    if (!mapping[name]) continue;
    const shotReference = field === 'referenceImage' && reference;
    const assetId = shotReference || inputs[field];
    const asset = project.assets.find(item => item.id === assetId && item.exists && item.kind === generationAssetKinds[field]);
    if (!asset) {
      if (shotReference) throw new Error('镜头参考图缺失，请在分镜审核中重新定位或选择图片');
      throw new Error(`请为 ${name} 选择有效的项目素材`);
    }
    assetInputs[name] = asset.id;
    assetRevisions[name] = asset.revision ?? 0;
  }
  return { assetInputs, assetRevisions };
}

function hasShotDraft(project) {
  return Boolean(project.production.draftShots || project.editorDrafts?.shots);
}

function buildGeneration(project, bundle, url, selectedIds, varySeed = false) {
  const template = resolveTemplate(project);
  const { workflow, mapping } = bundle;
  const common = {
    url, workflow, mapping,
    outputKinds: mapping.frameCount ? ['video'] : template.outputKinds,
    templateVersion: project.template_version,
  };
  const fixedSeed = mapping.seed ? workflowSeed(workflow, mapping.seed) : undefined;
  if (template.id === 'enhance') return [{
    ...common, ...generationInputs(project, template, mapping),
    values: fixedSeed === undefined ? {} : { seed: fixedSeed }, label: '画质增强',
  }];
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 300) throw new Error('请选择要生成的已确认分镜');
  if (hasShotDraft(project)) throw new Error('请确认或放弃分镜草稿后再生成');
  if ((project.production.reviewedInputRevision ?? 0) !== (project.production.inputRevision ?? 0)) {
    throw new Error('分析输入已变更，请重新确认分镜后再生成');
  }
  const requested = new Set(selectedIds);
  const shots = project.shots.filter(shot => requested.has(shot.id) && shot.status === 'approved');
  if (shots.length !== requested.size) throw new Error('只能为当前项目的已确认分镜生成镜头');
  const seedBinding = varySeed ? shotSeedBinding(workflow, mapping) : undefined;
  const usedSeeds = new Set(seedBinding ? [
    workflowSeed(workflow, seedBinding), ...(project.jobs ?? []).filter(job => job.kind === 'comfy').map(job => JSON.parse(job.detail).values?.seed),
  ] : []);
  return shots.map(shot => {
    const values = shotValues(shot, workflow, mapping);
    if (fixedSeed !== undefined) values.seed = fixedSeed;
    if (seedBinding) {
      // This range fits the common integer sampler inputs and survives JSON round trips.
      let seed;
      do { seed = randomInt(1, 2 ** 31); } while (usedSeeds.has(seed));
      usedSeeds.add(seed);
      values.seed = seed;
    }
    let inputs;
    try {
      inputs = generationInputs(project, template, mapping, shot);
    } catch (error) {
      throw new Error(`分镜「${shot.title}」：${error.message}`);
    }
    return { ...common, ...inputs, shotId: shot.id, label: shot.title, values, ...(seedBinding && !mapping.seed && { seedBinding }) };
  });
}

module.exports = {
  templates, resolveTemplate, generationInputs, buildGeneration, hasShotDraft, supportsShotReferences, shotValues, shotSchema, analysisInputs,
  inputMediaKinds, unsupportedAssetBinding, validateTemplateMapping, maxLtxShotSeconds, shotDuration, validateLtxShotDuration, workflowSeed,
};
