// API docs: the OpenAPI document and Swagger UI, both public (they describe the API; they
// grant nothing). Swagger UI's files are served from the installed package, never a CDN, and
// our own initializer points it at the document, so the strict CSP stays as it is.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import express, { Router } from 'express';
import { buildOpenApiDocument } from './openapi.ts';

const SWAGGER_UI_DIR = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);

const INITIALIZER = `window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/api/v1/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
  });
};
`;

export function createDocsRouters(version: string): { openApi: Router; ui: Router } {
  // Built once: the document only changes with a deploy.
  const document = JSON.stringify(buildOpenApiDocument(version));

  const openApi = Router();
  openApi.get('/openapi.json', (_req, res) => {
    res.type('application/json').set('Cache-Control', 'public, max-age=300').send(document);
  });

  const ui = Router();
  ui.get('/swagger-initializer.js', (_req, res) => {
    res.type('application/javascript').send(INITIALIZER);
  });
  ui.use(express.static(SWAGGER_UI_DIR, { index: 'index.html', redirect: true }));

  return { openApi, ui };
}
