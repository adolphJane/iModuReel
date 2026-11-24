const {test}=require('node:test');const assert=require('node:assert/strict');const {validateWorkflow}=require('../electron/services.cjs');const {templates}=require('../electron/templates.cjs');
test('three versioned production templates',()=>{assert.deepEqual(templates.map(t=>t.id),['drama','fashion','enhance']);assert.ok(templates.every(t=>t.version&&t.stages.length))});
test('workflow mapping rejects missing input',()=>{assert.throws(()=>validateWorkflow({'6':{class_type:'X',inputs:{text:''}}},{prompt:{node:'7',input:'text'}}));assert.equal(validateWorkflow({'6':{class_type:'X',inputs:{text:''}}},{prompt:{node:'6',input:'text'}}),true)});

const { buildPrompt } = require('../electron/services.cjs');
const { preset, presets, projectPresets, mpsVideoWorkflow } = require('../electron/presets.cjs');
const { buildGeneration, resolveTemplate, validateTemplateMapping } = require('../electron/templates.cjs');

test('a stored template version controls its available workflows and mapping independently of the catalog', () => {
  const template = { ...templates[0], version: 2, fields: ['script'], outputKinds: ['image'] };
  const project = {
    template_id: template.id, template_version: template.version, template_snapshot: JSON.stringify(template),
    production: { inputs: { script: 'Opening', referenceImage: 'old-asset' } },
    assets: [{ id: 'old-asset', kind: 'image', exists: true }],
    shots: [{ id: 'shot', title: 'Opening', prompt: 'A morning walk', duration: 2, status: 'approved' }],
  };
  assert.deepEqual(resolveTemplate(project), template);
  assert.deepEqual(projectPresets(template).map(item => item.id), ['still']);
  const generate = presetId => buildGeneration(project, preset('drama', presetId), 'http://127.0.0.1:8188', ['shot']);
  assert.throws(() => generate('reference-video'), /不包含 referenceImage 输入/);
  assert.throws(() => generate('video'), /不支持动态镜头输出/);
  const [payload] = generate('still');
  assert.equal(payload.templateVersion, 2);
  assert.deepEqual(payload.outputKinds, ['image']);
  assert.equal(payload.values.prompt, project.shots[0].prompt);

  const legacy = { id: 'drama', version: 1, name: '早期短剧', analysisPrompt: '早期分析提示词' };
  assert.deepEqual(resolveTemplate({ ...project, template_snapshot: JSON.stringify(legacy) }), { ...templates[0], ...legacy });
});

test('built-in video presets bind approved shots and accept only video outputs', () => {
  for (const templateId of ['drama', 'fashion']) {
    const template = templates.find(item => item.id === templateId);
    for (const specification of presets(templateId).filter(item => item.mapping.frameCount)) {
      const invalid = structuredClone(specification.workflow);
      invalid['11'].inputs.fps = ['1', 0];
      assert.throws(() => validateTemplateMapping(template, specification.mapping, invalid), /填写固定帧率/);
      const project = {
        template_id: templateId,
        template_version: template.version,
        template_snapshot: JSON.stringify(template),
        production: { inputs: { productImage: 'image', referenceImage: 'image' } },
        assets: [{ id: 'image', kind: 'image', exists: true }],
        shots: [{ id: 'shot', title: 'Opening', prompt: 'Slow camera push over a cotton jacket', duration: 2.25, status: 'approved' }],
      };
      const [payload] = buildGeneration(project, specification, 'http://127.0.0.1:8188', ['shot']);
      const uploads = Object.fromEntries(Object.keys(payload.assetInputs).map(key => [key, 'uploaded.png']));
      const prompt = buildPrompt(payload.workflow, payload.mapping, { ...payload.values, ...uploads });
      assert.equal(prompt['5'].inputs.length, 57);
      assert.equal(prompt['3'].inputs.text, project.shots[0].prompt);
      assert.equal(prompt['11'].inputs.fps, 24);
      assert.deepEqual(payload.outputKinds, ['video']);
      if (templateId === 'fashion' || specification.id === 'reference-video') {
        assert.equal(prompt['13'].inputs.image, 'uploaded.png');
        assert.deepEqual(prompt['5'].inputs.image, ['16', 0]);
        assert.deepEqual(prompt['16'], {
          class_type: 'ResizeAndPadImage',
          inputs: { image: ['13', 0], target_width: 384, target_height: 640, padding_color: 'white', interpolation: 'lanczos' },
        });
        assert.throws(() => buildGeneration({ ...project, assets: [] }, specification, payload.url, ['shot']), /有效的项目素材/);
      }
      const long = { ...project, shots: [{ ...project.shots[0], duration: 9 }] };
      assert.throws(() => buildGeneration(long, specification, payload.url, ['shot']), /时长上限/);
    }
  }
});

test('fashion still fits the product photo into the model canvas before encoding', () => {
  const { workflow, mapping } = preset('fashion', 'still');
  assert.deepEqual(mapping.productImage, { node: '4', input: 'image' });
  assert.deepEqual(workflow['9'], {
    class_type: 'ResizeAndPadImage',
    inputs: { image: ['4', 0], target_width: 512, target_height: 768, padding_color: 'white', interpolation: 'lanczos' },
  });
  assert.deepEqual(workflow['5'].inputs.pixels, ['9', 0]);
});

test('MPS video optimizations change only the runtime copy of a built-in workflow', () => {
  for (const { workflow, mapping } of [...presets('drama'), ...presets('fashion')].filter(item => item.mapping.frameCount)) {
    const mapped = mpsVideoWorkflow(workflow, mapping, 49);
    assert.equal(mapped['2'].class_type, 'iModuReelLTXVTextEncoder');
    assert.deepEqual(mapped['2'].inputs, { clip_name: workflow['2'].inputs.clip_name });
    assert.equal(workflow['2'].class_type, 'CLIPLoader');
    const { '14': attention, '15': validation, ...remaining } = mapped;
    assert.deepEqual(attention, { class_type: 'iModuReelLTXVAttention', inputs: { model: workflow['9'].inputs.model } });
    assert.deepEqual(validation, { class_type: 'iModuReelLTXVLatents', inputs: { samples: workflow['10'].inputs.samples } });
    assert.deepEqual(mapped['9'].inputs.model, ['14', 0]);
    assert.deepEqual(mapped['10'].inputs.samples, ['15', 0]);
    assert.deepEqual({ ...remaining, '2': workflow['2'], '9': workflow['9'], '10': workflow['10'] }, workflow);
    assert.equal(mapped['10'].class_type, 'VAEDecode');

    const long = mpsVideoWorkflow(workflow, mapping, 193);
    assert.deepEqual(long['10'], {
      class_type: 'VAEDecodeTiled',
      inputs: { ...mapped['10'].inputs, tile_size: 1024, overlap: 64, temporal_size: 56, temporal_overlap: 16 },
    });
    assert.deepEqual({ ...long, '10': mapped['10'] }, mapped);

    if (workflow['16']) {
      const legacy = structuredClone(workflow);
      delete legacy['16'];
      legacy['5'].inputs.image = ['13', 0];
      assert.equal(mpsVideoWorkflow(legacy, mapping, 49)['2'].class_type, 'iModuReelLTXVTextEncoder');
    }

    const customized = structuredClone(workflow);
    customized['7'].inputs.steps++;
    assert.strictEqual(mpsVideoWorkflow(customized, mapping, 193), customized);
  }
});

test('ComfyUI step progress is scoped to the submitted prompt and ignores preview frames', t => {
  const sockets = [];
  class FakeWebSocket extends EventTarget {
    static CLOSING = 2;
    readyState = 1;
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSING;
      this.dispatchEvent(new Event('close'));
    }
  }
  const native = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', native));
  const { observeComfyProgress } = require('../electron/services.cjs');
  const progress = [];
  const close = observeComfyProgress('https://comfy.example/api', 'client-id', () => 'received-id', step => progress.push(step));
  try {
    const [socket] = sockets;
    assert.equal(String(socket.url), 'wss://comfy.example/api/ws?clientId=client-id');
    const deliver = data => socket.dispatchEvent(new MessageEvent('message', { data }));
    deliver(Buffer.from([1, 2, 3]));
    deliver(JSON.stringify({ type: 'progress', data: { prompt_id: 'someone-else', node: '9', value: 5, max: 20 } }));
    deliver(JSON.stringify({ type: 'progress', data: { prompt_id: 'received-id', node: '9', value: 5, max: 20 } }));
    assert.deepEqual(progress, [{ node: '9', value: 5, max: 20 }]);
  } finally {
    close();
  }
  assert.equal(sockets[0].readyState, FakeWebSocket.CLOSING);
});
