# Relatório: falha do hook `security-guidance@inline` (Claude Desktop, Windows)

Data: 2026-10-05 · Sessão: 42130684-cc85-49d5-bd2d-5e44160b6d30 · Plugin v2.0.8
Autor: Claude Code (Sonnet 5.5) · Destino: revisão por outros modelos/agentes

## 1. Sintoma

Em todo `SessionStart`, `UserPromptSubmit`, e nos hooks assíncronos de `Stop` /
`PostToolUse(Bash: git commit|push)`, o harness registra `hook_non_blocking_error`:

```
C:\Users\USER\AppData\Local\Microsoft\WindowsApps\python3.13.exe: can't open file
'C:\Users\USER\AppData\Roaming\Claude\local-agent-mode-sessions\aa6ad9f0-...\790b9f23-...\rpm\plugin_01MsZoTpmgRVtWrC5gZtXVza\hooks\security_reminder_hook.py':
[Errno 2] No such file or directory
This hook comes from the security-guidance@inline plugin.
```

Efeito colateral pior que o erro em si: os hooks com `asyncRewake` (Stop, commit, push)
devolvem esse stderr ao modelo como se fosse "Background security review ... found issues".
Resultado: notificações falsas de "achados de segurança" que não são achados, e que
induzem o agente a "endereçar" um problema inexistente (ruído e risco de
prompt-injection-like confusion). **Nenhuma revisão de segurança real está rodando.**

## 2. Causa raiz (confirmada por reprodução)

O arquivo **existe**; o interpretador escolhido é que não consegue enxergá-lo.

1. `hooks/sg-python.sh` (Pass 1) tenta `python3.13 → 3.12 → 3.11 → 3.10` e usa o primeiro
   que passa em `probe` (`-c 'print(version)'`) com versão >= 3.10.
2. Nesta máquina `python3.13` resolve para
   `C:\Users\USER\AppData\Local\Microsoft\WindowsApps\python3.13` — um **alias de execução
   da Microsoft Store** do pacote MSIX `PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0`.
   Ele funciona (3.13.14), logo passa no probe.
3. O Claude Desktop também é MSIX (`Claude_pzs8sxrjxfjjc`). Seus dados em
   `%APPDATA%\Roaming\Claude\...` (onde ficam os plugins `rpm\plugin_*`) são arquivos
   **virtualizados por pacote** (`...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\...`).
   Processos filhos do Claude (bash, `py -3`) herdam essa visão e enxergam o arquivo;
   o Python da Store, que tem **outra identidade de pacote**, vê o `Roaming` real, onde o
   arquivo não existe → `Errno 2`.
4. O shim passa o caminho já em formato Windows (`C:\...`), então o ramo `cygpath -w`
   (só para args iniciados por `/`) não é o problema aqui. O bug de path citado no
   próprio script (#2043) é outro.

### Evidência (executada no ambiente)

| Interpretador | `os.path.exists(...\hooks\ensure_agent_sdk.py)` |
|---|---|
| `python3.13` (WindowsApps, Store alias) | **False** |
| `python` (WindowsApps, mesmo pacote 3.13) | **False** |
| `py -3` (Python 3.14.2, `...\Local\Python\pythoncore-3.14-64`, fora da Store) | **True** |
| bash (Git Bash) `test -f` | True |

Os 5 arquivos do hook estão em disco (`hooks/` com 13 arquivos, `plugin_01MsZo...`
atualizado em 2026-10-05 22:00). `python3.12/3.11/3.10` não existem; `py -3` existe e funciona.

## 3. Contexto relevante / fatores descartados

- `~/.claude/settings.json` tem `env.SECURITY_GUIDANCE_DISABLE=1`. **Não ajuda**: o kill switch
  é lido dentro de `security_reminder_hook.py` (linha ~171/2261), que nunca chega a executar.
  Além disso, o plugin aqui é o `@inline` instalado pelo app Desktop (manifest em
  `local-agent-mode-sessions/.../rpm/manifest.json`, "Security Guidance",
  `installationPreference: available`), **não** o do CLI: `installed_plugins.json` só lista
  `aws-startup-advisor`, e `enabledPlugins` não menciona security-guidance.
- A cópia em `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/security-guidance`
  (mesma v2.0.8) é inócua; não é a que está sendo executada.
- Não é problema de código do repo ProofSec nem dos invariantes INV-1..8 do `AGENTS.md`.
- `ensure_agent_sdk.py` e `security_reminder_hook.py` falham pela mesma razão; só 1 tentativa
  por evento (stderr exit 2, "Treating as non-blocking").

## 4. Impacto

- Cobertura de revisão de segurança por esse plugin: **zero** (padrões em Edit/Write e revisão
  LLM no Stop/commit/push não rodam). Não confiar nele como controle (ver §3 do AGENTS.md:
  a revisão independente é da Antigravity).
- Ruído: ~1 notificação falsa por commit/push/Stop; custo de contexto e risco de agentes
  tratarem como achado real.

## 5. Correções possíveis (da mais simples à mais invasiva)

1. **Desativar o plugin Security Guidance** no Claude Desktop (Settings → Plugins) enquanto
   não houver correção. Resolve o ruído imediatamente; sem risco.
2. **Desligar os aliases da Store**: Windows Settings → Apps → Advanced app settings →
   App execution aliases → desmarcar `python.exe`, `python3.exe`, `python3.13.exe`.
   O shim então cai em `py -3` (3.14, enxerga os arquivos). Requer ação do usuário;
   afeta só PATH de Python.
3. **Correção upstream** em `hooks/sg-python.sh` (repo `anthropics/claude-plugins-official`):
   - ignorar candidatos cujo `command -v` contenha `/WindowsApps/` (ou `\WindowsApps\`);
     preferir `py -3` no Windows; e/ou
   - no probe, validar que o interpretador consegue abrir o próprio script
     (`"$cmd" -c 'import sys;open(sys.argv[1]).close()' "$script"`), caindo para o próximo.
4. **Hardening do harness/plugin**: não devolver stderr de falha de infraestrutura como
   `rewakeMessage` de "security review found issues" (distinguir erro de execução de achado).

Não editei `sg-python.sh` nem as configurações: o arquivo vive no diretório gerenciado
do app (`rpm\plugin_*`), sobrescrito a cada atualização, e mexer em plugins/segurança
exige decisão do usuário (AGENTS.md §5).

## 6. Pontos para os revisores validarem

- Confirmar a hipótese de virtualização MSIX (Claude vs. Python da Store) lendo o conteúdo de
  `...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\...` vs. `%APPDATA%\Roaming\Claude\...`
  (visão do Python 3.13 Store). A reprodução (tabela §2) é consistente com isso mas a leitura
  direta do caminho "real" não foi feita sob a identidade do Python da Store.
- Testar a correção 2 abrindo nova sessão e verificando que `SessionStart` roda sem
  `hook_non_blocking_error`.
- Verificar se o mesmo padrão afeta outros plugins `@inline` com hooks no Desktop.

## 7. Arquivos e fontes consultados

- `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json`
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/security-guidance/hooks/{hooks.json,sg-python.sh,security_reminder_hook.py}`
- `%APPDATA%\Claude\local-agent-mode-sessions\aa6ad9f0-...\790b9f23-...\rpm\{manifest.json,plugin_01MsZoTpmgRVtWrC5gZtXVza\}`
- Transcript da sessão `~/.claude/projects/C--Users-USER--gemini-antigravity-scratch-proofsec/42130684-...jsonl`
  (eventos `hook_non_blocking_error`, hookEvent SessionStart e UserPromptSubmit)
