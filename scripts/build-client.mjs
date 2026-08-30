/**
 * Build the browser client bundle into `lib/client.js` in the dsh
 * `window.__ModuleLoader__.load({ id, factory })` closure format (the same
 * artifact the official `tsdown.client.ts` preset and dsh-pet emit).
 *
 * Framework modules are externals resolved through the factory's injected
 * `require` (platform seeds + `dsh.client.inject` rows); everything else is
 * inlined. Run after `tsc -p tsconfig.build.json` (which emits the node
 * half into `lib/`).
 */

import { build } from 'esbuild'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Specifiers the loader resolves through its module table. */
const EXTERNAL = [
  // Platform seeds (window.__DSH_BOOT__ seed table).
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  // dsh.client.inject rows (arrive before this bundle materializes).
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-settings',
]

const banner = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')

const footer = [
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  external: EXTERNAL,
  banner: { js: banner },
  footer: { js: footer },
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  write: false,
})

const out = join(root, 'lib/client.js')
mkdirSync(dirname(out), { recursive: true })
for (const file of result.outputFiles) {
  const path = file.path.endsWith('.map')
    ? `${out}.map`
    : out
  writeFileSync(path, file.contents)
}
console.log(`client bundle -> ${out} (${result.outputFiles[0].contents.length} bytes)`)
