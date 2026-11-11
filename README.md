# dsh-task-overlay

Overlay nativo (Win32) para o **DeepSeek Harness**: avisa quando uma tarefa termina, falha ou precisa da sua intervenção — mesmo com o app em segundo plano.

Sem Electron, sem janela de navegador: é um executável Win32 pequeno, sempre no topo, que some sozinho quando você entra no app.

## Recursos

- **Card nativo** sobreposto no canto superior direito: ao clicar, traz o DeepSeek Harness para frente.
- **Sem roubar foco ao aparecer**: o card é exibido sem ativar sua janela; o Harness é ativado quando você clica no card.
- **Cores por estado**: concluído (verde), aprovação (âmbar), erro (vermelho), bloqueado/truncado/interrompido (laranja), pergunta (azul).
- **Tempo total da tarefa** no card: quanto tempo passou do início do turno até o alerta.
- **Card compacto**: a altura cresce só quando há texto demais (máximo de 3 linhas e um teto de altura), então ele nunca cobre a tela.
- **Alerta sonoro**: toca quando o card aparece e **repete a cada 30 segundos** enquanto o card estiver na tela. Para quando você entra no app.
- **Som por estado**: cada notificação usa o áudio da sua pasta; estados sem áudio usam o som padrão de tarefa concluída (veja abaixo).
- **Falha de subagente** aparece no card, atribuída à sessão pai.

## Requisitos

- Windows 10 ou 11
- DeepSeek Harness `0.2.1-rc.5` ou superior (qualquer perfil que tenha o Plugin Manager)
- Nada além disso: o binário nativo já vem compilado dentro do pacote.

## Instalação

### Linha de comando

```bash
dsh plugin --profile desktop add github:onegai0/dsh-task-overlay#455b0a8fcda5ee8e4968c9f49872e639cf48bf35
```

Para o aplicativo DeepSeek Harness no Windows, use o perfil `desktop`, como no comando acima. O perfil é o que guarda os plugins instalados.

O commit `455b0a8fcda5ee8e4968c9f49872e639cf48bf35` fixa a revisão com suporte a clique no card. A tag antiga `v1.0.0` não contém esse suporte. Mantenha o commit no comando para instalar essa mesma revisão, sem acompanhar futuras mudanças da `main`.

### Plugin Manager (interface)

Abra **Configurações → Plugins** no Harness, use a ação de instalar bundle e informe a mesma especificação:

```
github:onegai0/dsh-task-overlay#455b0a8fcda5ee8e4968c9f49872e639cf48bf35
```

### Desenvolvimento local (link)

Para trabalhar no código, aponte o perfil para a pasta local em vez de baixar do GitHub:

```bash
dsh plugin --profile <seu-perfil> add link:/caminho/absoluto/ate/dsh-task-overlay
```

Com `link:`, as alterações no `index.js` entram no Host sem reiniciar (o Harness recompõe o perfil). O binário nativo continua precisando ser recompilado e o helper reiniciado (veja [Desenvolvimento](#desenvolvimento)).

## Onde fica instalado

| Coisa | Caminho |
|---|---|
| Código do plugin | `<perfil>/node_modules/@local/dsh-task-overlay` (cópia instalada pelo GitHub) |
| Dados em runtime (estado) | `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\` |
| Sons por estado | `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\sounds\<estado>\` |

O pacote **não escreve nada dentro da pasta do projeto**: estado e som ficam em `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\`, que é a mesma pasta usada pelo app em `%LOCALAPPDATA%\DeepSeekHarness\`.

## Som customizado

O plugin cria uma pasta para cada estado em `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\sounds\`. As pastas seguem o `kind` da notificação: `max-tokens` usa `truncated`, e um aborto por hook usa `interrupted`:

| Pasta | Estado |
|---|---|
| `completed\` | Tarefa concluída (som padrão) |
| `error\` | A tarefa falhou |
| `blocked\` | A tarefa foi bloqueada |
| `truncated\` | Resposta truncada |
| `interrupted\` | A tarefa foi interrompida |
| `approval\` | Aprovação necessária |
| `question\` | Sua intervenção é necessária |

1. Copie um arquivo `.wav`, `.mp3`, `.m4a` ou `.wma` para a pasta do estado desejado.
2. Pronto — o próximo alerta toca esse arquivo.

O helper procura o arquivo a cada alerta, então não precisa reiniciar nada; se houver mais de um arquivo de áudio na mesma pasta, use apenas um.

Quando a pasta do estado não tem áudio, o helper usa automaticamente o som de `completed`. Se também não houver som nessa pasta, ele procura um áudio legado diretamente em `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\` e, por último, usa o bipe padrão do Windows.

O `.wav` é reproduzido direto (Win32 `PlaySound`); `.mp3`/`.m4a`/`.wma` usam o MCI do Windows e dependem dos codecs instalados no sistema.

## Como funciona

- O plugin do Host (`index.js`) escuta os eventos de sessão (`turn/start`, `assistant/message`, `turn/end`, `approval/asked`, `tool/call`) e decide o que merece aviso.
- Cada aviso vira um estado em `%LOCALAPPDATA%\DeepSeekHarness\dsh-task-overlay\state.bin` (campos separados por NUL).
- O helper nativo (`native/overlay.cpp`) lê esse arquivo a cada 150 ms, desenha o card, redimensiona conforme o texto e toca o som.
- O helper acompanha os processos do DeepSeek Harness e encerra automaticamente quando o aplicativo fecha.

Subagentes só notificam quando algo dá errado; o sucesso de um subagente é silencioso.

## Desenvolvimento

```bash
npm test          # testes do Host (node --test)
npm run build:native
```

`build:native` precisa de um `g++` MinGW-w64 no `PATH` (por exemplo o UCRT64 do [MSYS2](https://www.msys2.org/)) e recompila `native/overlay.cpp` em `native/dsh-task-overlay.exe`.

Depois de recompilar, **encerre o helper antigo** antes de trocar o `.exe` (o Windows trava o arquivo em uso) e publique um evento para o helper novo subir:

```powershell
Get-Process -Name dsh-task-overlay -ErrorAction SilentlyContinue | Stop-Process -Force
```

## Licença

MIT
