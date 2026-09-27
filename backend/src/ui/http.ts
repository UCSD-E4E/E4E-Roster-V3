import type { Request as ExpressRequest, Response } from 'express';

export type FormFields = Record<string, string | string[]>;

/** Preserve repeated form fields while adapting browser form data to service input. */
export function formFields(form: FormData): FormFields {
  const fields: FormFields = {};
  form.forEach((value, key) => {
    const existing = fields[key];
    fields[key] = existing === undefined
      ? String(value)
      : [...(Array.isArray(existing) ? existing : [existing]), String(value)];
  });
  return fields;
}

/** Adapt the parsed Express request for React Router's server-side handler. */
export function webRequest(req: ExpressRequest): globalThis.Request {
  const protocol = req.protocol || 'http';
  const host = req.get('host') ?? 'localhost';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(req.body as Record<string, unknown>)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null) body.append(name, String(item));
      }
    }
    init.body = body;
    headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
  }
  return new globalThis.Request(`${protocol}://${host}${req.originalUrl}`, init);
}

export async function sendFetchResponse(response: globalThis.Response, res: Response): Promise<void> {
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}
