import { generateRunningHub } from './runninghub.js';
import { generateComfy } from './comfyui.js';
import { downloadTaskImage } from './task-download.js';

// Credentials and destination URLs come exclusively from the saved administrator model.
export async function generateTaskImage(model, step, images, signal, submitted, resumeId) {
  const input = { model: model.model, prompt: step.prompt, n: 1, ...step.parameters };
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) if (value != null) form.set(key, String(value));
  images.forEach((image, i) => form.append(images.length === 1 ? 'image' : 'image[]', new Blob([image.bytes], { type: image.mime }), `reference-${i}.png`));
  if (step.runninghubInputs) form.set('runninghubInputs', JSON.stringify(step.runninghubInputs));
  let result;
  if (model.apiFormat === 'runninghub') result = await generateRunningHub(model, form, signal, submitted, fetch, resumeId);
  else if (model.apiFormat === 'comfyui') result = await generateComfy(model, input, signal, submitted, resumeId);
  else {
    let base = model.baseUrl.replace(/\/+$/, '');
    const gemini = model.apiFormat === 'gemini';
    if (gemini) base = base.replace(/\/v1beta$/, '');
    else if (!base.endsWith('/v1')) base += '/v1';
    const url = gemini ? `${base}/v1beta/models/${encodeURIComponent(model.model.replace(/^models\//, ''))}:generateContent`
      : `${base}/images/${images.length ? 'edits' : 'generations'}`;
    const headers = gemini ? { 'x-goog-api-key': model.apiKey } : { Authorization: `Bearer ${model.apiKey}` };
    let body;
    if (gemini) {
      body = JSON.stringify({ ...(step.systemPrompt ? { systemInstruction: { parts: [{ text: step.systemPrompt }] } } : {}), contents: [{ role: 'user', parts: [{ text: step.prompt }, ...images.map((image) => ({ inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } }))] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...step.gemini } });
    } else {
      const extra = { output_format: 'png', ...(/gpt-image/.test(model.model) ? {} : { response_format: 'b64_json' }) };
      if (images.length) { for (const [key, value] of Object.entries(extra)) form.set(key, value); body = form; }
      else body = JSON.stringify({ ...input, ...extra });
    }
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型服务返回 HTTP ${response.status}，请查看平台任务记录，不会自动重提。`); }
    result = await response.json();
    if (gemini) result = { data: result.candidates?.flatMap((candidate) => candidate.content?.parts || []).flatMap((part) => {
      const image = part.inlineData || part.inline_data;
      const file = part.fileData || part.file_data;
      return image?.data ? [{ b64_json: image.data }] : file?.fileUri || file?.file_uri ? [{ url: file.fileUri || file.file_uri }] : [];
    }) };
  }
  if (model.apiFormat === 'runninghub') return result.data.map((image) => Buffer.from(image.b64_json, 'base64'));
  const image = result.data?.[0];
  if (typeof image?.b64_json === 'string') return Buffer.from(image.b64_json, 'base64');
  if (typeof image?.url === 'string') {
    return downloadTaskImage(image.url, new URL(model.baseUrl).origin, signal);
  }
  throw new Error('模型未返回可保存的图片，请查看平台任务记录。');
}
