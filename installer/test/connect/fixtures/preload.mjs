import fs from 'node:fs';
globalThis.fetch = async (url, options) => {
  fs.appendFileSync(process.env.TEST_API_LOG, JSON.stringify({ url, method: options?.method, body: options?.body }) + '\n');
  const models = (process.env.TEST_MODELS ?? process.env.TEST_MODEL).split(',');
  if (String(url).endsWith('/models'))
    return new Response(
      JSON.stringify({ data: models.map((id) => ({ id, display_name: id === process.env.TEST_MODEL ? 'Chosen model' : id })) }),
      { status: Number(process.env.TEST_MODELS_STATUS ?? 200) },
    );
  const requested = options?.body ? JSON.parse(options.body).model : undefined;
  if ((process.env.TEST_PROBE_REJECT ?? '').split(',').includes(requested)) {
    return new Response(
      JSON.stringify({
        statusCode: 400,
        message: `Модель «${requested}» недоступна на пробном балансе. Доступная модель: Trial (${process.env.TEST_PROBE_SUGGEST})`,
      }),
      { status: 400 },
    );
  }
  const status = Number(process.env.TEST_PROBE_STATUS ?? 200);
  const body =
    status !== 200
      ? { error: { message: 'test API error' } }
      : String(url).endsWith('/responses')
        ? {
            object: 'response',
            status: process.env.TEST_GENERATION_STATUS ?? 'completed',
            error: process.env.TEST_GENERATION_STATUS === 'failed' ? { message: 'Generation failed' } : null,
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          }
        : { type: 'message', content: [{ type: 'text', text: 'OK' }] };
  return new Response(JSON.stringify(body), { status });
};
