import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { workspaceConfigSchema } from '../src/core/config/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'schema');

async function main(): Promise<void> {
  const jsonSchema = zodToJsonSchema(workspaceConfigSchema, {
    name: 'EnvbeamWorkspaceConfig',
    $refStrategy: 'none',
  });
  const withMeta = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://envbeam.dev/schema/envbeam.schema.json',
    title: 'envbeam workspace config (.envbeam.yaml)',
    ...jsonSchema,
  };
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'envbeam.schema.json');
  await fs.writeFile(outFile, JSON.stringify(withMeta, null, 2) + '\n');
  process.stdout.write(`Wrote ${path.relative(process.cwd(), outFile)}\n`);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
