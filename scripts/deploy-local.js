// scripts/deploy-local.js
// Roda sozinho depois de `npm run build:native` (via "postbuild:native").
// 1) descobre onde o helper em execucao esta instalado
// 2) encerra o helper
// 3) copia o .exe recem-compilado por cima das copias instaladas
// 4) atualiza instalacoes nos perfis do DSH (~/.dsh/profiles/*/node_modules/@local/dsh-task-overlay)
//
// Se o plugin foi instalado com `link:`, o helper ja roda direto da pasta do
// projeto: nada para copiar, so reinicia.
//
// Para um caminho extra (helper nao esta rodando agora), defina:
//   $env:DSH_OVERLAY_TARGET = "C:\...\node_modules\@local\dsh-task-overlay\native\dsh-task-overlay.exe"

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const built = resolve(__dirname, '..', 'native', 'dsh-task-overlay.exe');
if (!existsSync(built)) {
  console.error(`[deploy-local] nao achei o build: ${built}`);
  process.exit(1);
}

function powershell(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 1) caminhos dos helpers em execucao (antes de encerrar)
const targets = new Set(
  powershell('Get-Process dsh-task-overlay -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => resolve(p)),
);
if (process.env.DSH_OVERLAY_TARGET) targets.add(resolve(process.env.DSH_OVERLAY_TARGET));

// 1.5) instalacoes nos perfis do DSH (~/.dsh/profiles/*/node_modules/@local/dsh-task-overlay)
const dshProfilesDir = join(homedir(), '.dsh', 'profiles');
if (existsSync(dshProfilesDir)) {
  for (const profile of readdirSync(dshProfilesDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    const pluginExe = join(dshProfilesDir, profile.name, 'node_modules', '@local', 'dsh-task-overlay', 'native', 'dsh-task-overlay.exe');
    if (existsSync(pluginExe)) {
      targets.add(resolve(pluginExe));
    }
  }
}

// 2) encerra o helper para liberar o arquivo
powershell('Get-Process dsh-task-overlay -ErrorAction SilentlyContinue | Stop-Process -Force');
sleep(400);

// 3) copia por cima, com algumas tentativas (o Windows solta o arquivo com um pequeno atraso)
let copied = 0;
for (const target of targets) {
  if (same(target, built)) continue; // link: ja e o mesmo arquivo
  let done = false;
  for (let attempt = 0; attempt < 10 && !done; attempt++) {
    try {
      copyFileSync(built, target);
      done = true;
    } catch {
      sleep(300);
    }
  }
  if (done) {
    copied++;
    console.log(`[deploy-local] atualizado: ${target}`);
  } else {
    console.error(`[deploy-local] FALHOU ao copiar para: ${target}`);
    process.exitCode = 1;
  }
}

if (targets.size === 0) {
  console.log('[deploy-local] nenhum helper em execucao, nenhum DSH_OVERLAY_TARGET e nenhuma instalacao DSH encontrada: so o build local foi atualizado.');
} else if (copied === 0 && process.exitCode !== 1) {
  console.log('[deploy-local] helper roda direto do projeto (link:), so foi reiniciado.');
}
console.log('[deploy-local] o helper novo sobe no proximo evento do DeepSeek Harness.');