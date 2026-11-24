const { isDeepStrictEqual } = require('node:util');
const { unsupportedAssetBinding } = require('./templates.cjs');

function modelScopeFile(repository, file, revision) {
  const query = new URLSearchParams({ Revision: revision, FilePath: file });
  return `https://www.modelscope.cn/api/v1/models/${repository}/repo?${query}`;
}

const stableDiffusion = {
  folder: 'checkpoints', name: 'v1-5-pruned-emaonly-fp16.safetensors', size: 2132696762,
  sha256: 'e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916',
  url: 'https://huggingface.co/Comfy-Org/stable-diffusion-1.5/resolve/ce8e3e3657a9b767b33fc0171ff91fb04aed1b2f/v1-5-pruned-emaonly-fp16.safetensors',
  mirrorUrl: modelScopeFile('Comfy-Org/stable-diffusion-1.5', 'v1-5-pruned-emaonly-fp16.safetensors', '7391748796deddff48781d84ad4bdbcac1d16db4'),
};
const realEsrgan = {
  folder: 'upscale_models', name: 'realesr-general-x4v3.pth', size: 4885111,
  sha256: '8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292',
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth',
  mirrorUrl: 'https://hf-mirror.com/jhj0517/realesr-general-x4v3/resolve/6aecc46ba1fc8cfdfe8643f090782e2e62c044cd/realesr-general-x4v3.pth',
};
const ltxVideo = {
  folder: 'checkpoints', name: 'ltx-video-2b-v0.9.5.safetensors', size: 6340729500,
  sha256: '720d15c9f19f7d0f6b2a92bbbc34410e2cfb2f6856a100b38f734fbf973d4adf',
  url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/264b74849c14c309f5aa49e114afcc5248f7663c/ltx-video-2b-v0.9.5.safetensors',
  mirrorUrl: modelScopeFile('AI-ModelScope/LTX-Video', 'ltx-video-2b-v0.9.5.safetensors', '709cb381965e78b6019ae4b2636437b138029ab5'),
};
const t5Encoder = {
  folder: 'text_encoders', name: 't5xxl_fp16.safetensors', size: 9787841024,
  sha256: '6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635',
  url: 'https://huggingface.co/Comfy-Org/Mochi-Preview/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors',
  mirrorUrl: modelScopeFile('Comfy-Org/Mochi-Preview', 'split_files/text_encoders/t5xxl_fp16.safetensors', 'dba96d31851e0844d71ae27298b32d829cc20011'),
};

function node(class_type, inputs) {
  return { class_type, inputs };
}

function frames(fashion) {
  const workflow = {
    '1': node('CheckpointLoaderSimple', { ckpt_name: stableDiffusion.name }),
    '2': node('CLIPTextEncode', { text: '', clip: ['1', 1] }),
    '3': node('CLIPTextEncode', { text: 'low quality, distorted, blurry, watermarks', clip: ['1', 1] }),
    '6': node('KSampler', { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0],
      seed: 0, steps: 24, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: fashion ? 0.36 : 1 }),
    '7': node('VAEDecode', { samples: ['6', 0], vae: ['1', 2] }),
    '8': node('SaveImage', { images: ['7', 0], filename_prefix: 'iModuReel/shot' }),
  };
  const mapping = { prompt: { node: '2', input: 'text' } };
  if (fashion) {
    workflow['4'] = node('LoadImage', { image: '' });
    workflow['9'] = node('ResizeAndPadImage', {
      image: ['4', 0], target_width: 512, target_height: 768, padding_color: 'white', interpolation: 'lanczos',
    });
    workflow['5'] = node('VAEEncode', { pixels: ['9', 0], vae: ['1', 2] });
    mapping.productImage = { node: '4', input: 'image' };
  } else workflow['5'] = node('EmptyLatentImage', { width: 512, height: 768, batch_size: 1 });
  return {
    id: 'still', outputKind: 'image',
    name: fashion ? '商品图生镜头' : '短剧分镜画面', workflow, mapping, models: [stableDiffusion],
    description: fashion ? '等比缩放商品参考图并补足画幅，生成静态镜头。' : '生成静态分镜画面，可按分镜时长加入时间线。',
  };
}

function video(imageRole, fitReference = true) {
  // The LTXV nodes and scheduler follow the ComfyUI 0.9.5 starter graphs.
  const size = { width: 384, height: 640, length: 97, batch_size: 1 };
  const latent = imageRole ? ['5', 2] : ['5', 0];
  const workflow = {
    '1': node('CheckpointLoaderSimple', { ckpt_name: ltxVideo.name }),
    '2': node('CLIPLoader', { clip_name: t5Encoder.name, type: 'ltxv', device: 'cpu' }),
    '3': node('CLIPTextEncode', { text: '', clip: ['2', 0] }),
    '4': node('CLIPTextEncode', { text: 'blurry, distorted, shaky, inconsistent motion', clip: ['2', 0] }),
    '5': node('EmptyLTXVLatentVideo', size),
    '6': node('LTXVConditioning', {
      positive: imageRole ? ['5', 0] : ['3', 0], negative: imageRole ? ['5', 1] : ['4', 0], frame_rate: 24,
    }),
    '7': node('LTXVScheduler', { latent, steps: 30, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1 }),
    '8': node('KSamplerSelect', { sampler_name: 'euler' }),
    '9': node('SamplerCustom', {
      model: ['1', 0], positive: ['6', 0], negative: ['6', 1], sampler: ['8', 0],
      sigmas: ['7', 0], latent_image: latent, add_noise: true, noise_seed: 0, cfg: 3,
    }),
    '10': node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] }),
    '11': node('CreateVideo', { images: ['10', 0], fps: 24 }),
    '12': node('SaveVideo', { video: ['11', 0], filename_prefix: 'iModuReel/video-shot', format: 'mp4', codec: 'h264' }),
  };
  const mapping = {
    prompt: { node: '3', input: 'text' },
    frameCount: { node: '5', input: 'length' },
  };
  if (imageRole) {
    workflow['13'] = node('LoadImage', { image: '' });
    if (fitReference) {
      workflow['16'] = node('ResizeAndPadImage', {
        image: ['13', 0], target_width: size.width, target_height: size.height, padding_color: 'white', interpolation: 'lanczos',
      });
    }
    workflow['5'] = node('LTXVImgToVideo', {
      ...size, positive: ['3', 0], negative: ['4', 0], vae: ['1', 2], image: [fitReference ? '16' : '13', 0], strength: 0.85,
    });
    mapping[imageRole] = { node: '13', input: 'image' };
  }
  return {
    id: imageRole === 'referenceImage' ? 'reference-video' : 'video', outputKind: 'video',
    name: imageRole === 'productImage' ? '商品图生成动态镜头' : imageRole ? '参考图生成动态镜头' : '文字生成动态镜头',
    workflow, mapping, models: [ltxVideo, t5Encoder],
    description: 'LTX Video 生成竖屏 MP4。每个镜头最长 8 秒，详细的英文画面和运镜描述通常效果更好。',
  };
}

function enhance() {
  return {
    id: 'enhance', outputKind: 'video',
    name: 'Real-ESRGAN 视频超分',
    description: '逐帧增强并保留音轨。较长或较大的素材会分段处理。',
    models: [realEsrgan],
    workflow: {
      '1': node('LoadVideo', { file: '' }),
      '2': node('GetVideoComponents', { video: ['1', 0] }),
      '3': node('UpscaleModelLoader', { model_name: realEsrgan.name }),
      '4': node('ImageUpscaleWithModel', { upscale_model: ['3', 0], image: ['2', 0] }),
      '5': node('CreateVideo', { images: ['4', 0], audio: ['2', 1], fps: ['2', 2] }),
      '6': node('SaveVideo', { video: ['5', 0], filename_prefix: 'iModuReel/enhanced', format: 'mp4', codec: 'h264' }),
    },
    mapping: { sourceVideo: { node: '1', input: 'file' } },
  };
}

function presets(templateId) {
  if (templateId === 'enhance') return [enhance()];
  if (templateId === 'drama') return [video(), video('referenceImage'), frames(false)];
  if (templateId === 'fashion') return [video('productImage'), frames(true)];
  throw new Error('未知项目模板');
}

function projectPresets(template) {
  if (!template.stages.includes('generate')) return [];
  return presets(template.id).filter(item =>
    template.outputKinds.includes(item.outputKind) && !unsupportedAssetBinding(template, item.mapping));
}

function preset(templateId, presetId) {
  const options = presets(templateId);
  const selected = presetId ? options.find(item => item.id === presetId) : options[0];
  if (!selected) throw new Error('此项目不支持该内置工作流');
  return selected;
}

function presetModels(templateId, presetId, source = 'original') {
  const { models } = preset(templateId, presetId);
  if (source === 'original') return models;
  if (source === 'modelscope') {
    return models.map(model => ({ ...model, url: model.mirrorUrl || model.url }));
  }
  throw new Error('请选择有效的模型下载源');
}

const setupGroups = [
  { id: 'still', name: '短剧与商品静态镜头', template: 'drama', preset: 'still' },
  { id: 'video', name: '短剧与商品动态镜头', template: 'drama', preset: 'video' },
  { id: 'enhance', name: '画质增强', template: 'enhance', preset: 'enhance' },
];

function setupModels(ids, source = 'original') {
  if (!Array.isArray(ids) || ids.length > setupGroups.length || ids.some(id => !setupGroups.some(group => group.id === id))) {
    throw new Error('请选择有效的模板模型');
  }
  if (!['original', 'modelscope'].includes(source)) throw new Error('请选择有效的模型下载源');
  const unique = new Map();
  for (const group of setupGroups.filter(group => ids.includes(group.id))) {
    for (const model of presetModels(group.template, group.preset, source)) {
      unique.set(model.folder + '/' + model.name, model);
    }
  }
  return [...unique.values()];
}

function isBuiltInEnhancement(workflow, mapping) {
  const builtin = enhance();
  return isDeepStrictEqual(workflow, builtin.workflow) && isDeepStrictEqual(mapping, builtin.mapping);
}

function mpsVideoWorkflow(workflow, mapping, frameCount) {
  if (workflow?.['2']?.inputs?.clip_name !== t5Encoder.name) return workflow;
  const builtIn = [undefined, 'referenceImage', 'productImage'].some(role => {
    const option = video(role, Boolean(workflow['16']));
    return isDeepStrictEqual(workflow, option.workflow) && isDeepStrictEqual(mapping, option.mapping);
  });
  if (!builtIn) return workflow;
  const decoder = { ...workflow['10'].inputs, samples: ['15', 0] };
  // LTX decodes seven latent frames to 49 output frames. Limit each long
  // decode tile to that size and overlap by two latent frames.
  const decode = frameCount > 49 ? node('VAEDecodeTiled', {
    ...decoder, tile_size: 1024, overlap: 64, temporal_size: 56, temporal_overlap: 16,
  }) : node('VAEDecode', decoder);
  return {
    ...workflow,
    '2': node('iModuReelLTXVTextEncoder', { clip_name: t5Encoder.name }),
    '9': { ...workflow['9'], inputs: { ...workflow['9'].inputs, model: ['14', 0] } },
    '10': decode,
    '14': node('iModuReelLTXVAttention', { model: workflow['9'].inputs.model }),
    '15': node('iModuReelLTXVLatents', { samples: workflow['10'].inputs.samples }),
  };
}

module.exports = { preset, presets, projectPresets, presetModels, isBuiltInEnhancement, mpsVideoWorkflow, setupGroups, setupModels };
