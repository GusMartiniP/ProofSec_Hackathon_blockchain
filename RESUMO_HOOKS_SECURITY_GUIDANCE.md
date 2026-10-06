# Resumo: hooks do plugin `security-guidance`

Data: 2026-10-05

## Pedido
Olhar a questão dos hooks "em sucu". O termo "sucu" não aparece no projeto; foi interpretado como o plugin `security-guidance`, confirmado depois pelo usuário ("reinstalar", "silenciar").

## O que foi feito
1. Busca por "hook" e "sucu" no ProofSec. Não há hooks por projeto (não existe `.claude/`) e "sucu" não aparece em lugar nenhum.
2. Leitura dos hooks do plugin `security-guidance` (`hooks.json`, README, `sg-python.sh`).
3. O plugin está instalado pelo gerenciador do app desktop, em `%APPDATA%\Claude\local-agent-mode-sessions\...\rpm\plugin_01MsZoTpmgRVtWrC5gZtXVza`, e está ativo (versão atualizada em 2026-10-06T00:42Z).
4. Verificado que `security_reminder_hook.py` existe nesse caminho (116 KB).
5. Reinstalação: não foi possível pela sessão (o plugin é gerenciado pelo app). Caminho indicado: gerenciador de plugins do app (desativar/remover e instalar de novo, depois abrir sessão nova). Não usar `/plugin install` pelo CLI, para não duplicar os hooks.
6. Silenciamento (autorizado pelo usuário): adicionado em `C:\Users\USER\.claude\settings.json`:
   ```json
   "env": { "SECURITY_GUIDANCE_DISABLE": "1" }
   ```
   Foi a única alteração em arquivos. O código do ProofSec não foi tocado.

## Problemas
1. **Erro do hook a cada turno:** `can't open file '...\security_reminder_hook.py': [Errno 2] No such file or directory`, embora o arquivo exista. Causa não determinada. Hipóteses: caminho não visível no contexto onde o hook roda, ou problema de caminho entre o bash e o `python3.13.exe` da Microsoft Store. O teste manual do `sg-python.sh` não foi feito.
2. **Erro de diagnóstico inicial:** foi dito que o plugin não estava ativo, por olhar só `~/.claude/settings.json`. Corrigido depois: ele está ativo via app.
3. **Silenciamento não confirmado:** só vale em sessão nova; não foi testado se a variável faz o hook parar.
4. **Controle de segurança desligado:** sem pattern warnings nem revisão por LLM no diff. Resta a revisão independente do Antigravity (`AGENTS.md` §1). Reativar quando o caminho for corrigido.
5. **Revisão por diff limitada:** o diretório não é um repositório git.

## Pendente
- Abrir sessão nova e verificar se os avisos pararam.
- Para corrigir a causa: rodar `sg-python.sh` com o hook em um terminal normal, ou reinstalar o plugin pelo app.
- Para reativar o plugin: remover o bloco `env` de `~/.claude/settings.json`.
