# Instala as dependências e monta o site (usado pelo instalar e pelo atualizar).
. (Join-Path $PSScriptRoot 'comum.ps1')
$e = Ler-Env

Titulo 'Servidor'
Rodar-Npm (Join-Path $Raiz 'server') @('ci', '--omit=dev', '--no-audit', '--no-fund')
Ok 'dependências do servidor'

Titulo 'Site (isso demora um pouco)'
Rodar-Npm (Join-Path $Raiz 'client') @('ci', '--no-audit', '--no-fund')
Rodar-Npm (Join-Path $Raiz 'client') @('run', 'build')
Ok 'site montado'

foreach ($bot in @(@('musicbot', 'MUSICBOT_TOKEN'), @('moviebot', 'MOVIEBOT_TOKEN'))) {
  if ($e[$bot[1]]) {
    Titulo "Bot $($bot[0])"
    Rodar-Npm (Join-Path $Raiz $bot[0]) @('ci', '--omit=dev', '--no-audit', '--no-fund')
    Ok $bot[0]
  }
}
