[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ProjectRef,
  [string] $SiteUrl = 'https://digistore.codeinktechnologies.com',
  [string] $Branch = 'main',
  [switch] $SkipGitHub,
  [switch] $SkipSecrets
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Require-Command([string] $Command) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required but was not found in PATH." }
}
function Read-PlainSecret([string] $Name) {
  $secure = Read-Host -Prompt $Name -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

Require-Command supabase
if (-not $SkipGitHub) { Require-Command git }

if (-not (Test-Path 'supabase/migrations')) { New-Item -ItemType Directory -Path 'supabase/migrations' | Out-Null }
$migration = 'supabase/migrations/20260822000000_digistore_schema.sql'
if (-not (Test-Path $migration)) {
  Copy-Item 'supabase/schema.sql' $migration
  Write-Host "Created initial migration: $migration" -ForegroundColor Yellow
}

Write-Host 'Signing in and linking Supabase…' -ForegroundColor Cyan
supabase login
supabase link --project-ref $ProjectRef

if (-not $SkipSecrets) {
  $secrets = @{
    SUPABASE_URL = "https://$ProjectRef.supabase.co"
    SUPABASE_ANON_KEY = (Read-PlainSecret 'SUPABASE_ANON_KEY')
    SUPABASE_SERVICE_ROLE_KEY = (Read-PlainSecret 'SUPABASE_SERVICE_ROLE_KEY')
    FLW_SECRET_KEY = (Read-PlainSecret 'FLW_SECRET_KEY')
    NOWPAYMENTS_API_KEY = (Read-PlainSecret 'NOWPAYMENTS_API_KEY')
    NOWPAYMENTS_IPN_SECRET = (Read-PlainSecret 'NOWPAYMENTS_IPN_SECRET')
    PUBLIC_SITE_URL = $SiteUrl
    SUPABASE_FUNCTIONS_URL = "https://$ProjectRef.supabase.co/functions/v1"
    STORE_NAME = 'DigiStore'
  }
  foreach ($entry in $secrets.GetEnumerator()) { supabase secrets set "$($entry.Key)=$($entry.Value)" --project-ref $ProjectRef }
}

Write-Host 'Previewing database migration…' -ForegroundColor Cyan
supabase db push --dry-run
$answer = Read-Host 'Apply the migration to the linked project? Type DEPLOY to continue'
if ($answer -ne 'DEPLOY') { throw 'Deployment cancelled before database changes.' }
supabase db push

$publicNoJwtFunctions = @('flutterwave-callback', 'nowpayments-ipn', 'sitemap', 'search-index', 'daily-content', 'download-book')

@('create-flutterwave-payment','flutterwave-callback','create-nowpayments-payment','nowpayments-ipn','download-book','sitemap','search-index','daily-content','admin-dashboard') | ForEach-Object {
  Write-Host "Deploying Edge Function: $_" -ForegroundColor Cyan
  if ($publicNoJwtFunctions -contains $_) {
    supabase functions deploy $_ --no-verify-jwt --project-ref $ProjectRef
  } else {
    supabase functions deploy $_ --project-ref $ProjectRef
  }
}

if (-not $SkipGitHub) {
  git add --all
  $changes = git status --porcelain
  if ($changes) { git commit -m 'Deploy DigiStore' }
  git push origin $Branch
  Write-Host 'GitHub deployment pushed. Ensure GitHub Pages is configured to serve the repository root from this branch.' -ForegroundColor Green
}

Write-Host "Deployment complete. In Supabase Auth, set Site URL and auth.html redirect URL to $SiteUrl." -ForegroundColor Green
