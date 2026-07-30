# Deploy — paso a paso en la terminal

Runbook para copiar/pegar. Cada comando trae **Para qué** sirve en el deploy. Los 3 pasos que
son de **navegador** (no de terminal) están marcados con 🖥️. Detalle completo en
[installation.md](installation.md).

> Resumen del deploy: subes **una librería** (con la lógica + la key) y **una plantilla**
> (el Sheet que copian los líderes). La terminal (`clasp`) solo mueve **código**; la key y la
> autorización se hacen en el navegador.

---

## 0. Preparación (una vez)

```bash
clasp --version
```
**Para qué:** confirmar que `clasp` está disponible (debe decir `3.3.0`). Si "command not found",
corre `source ~/.bashrc` (el PATH ya quedó configurado ahí).

```bash
clasp login
```
**Para qué:** autenticar `clasp` con tu cuenta Google. Abre el navegador; autoriza. Es lo que
permite crear/subir proyectos de Apps Script a **tu** Drive.

> ⚠️ **En VS Code Remote / contenedor (el navegador está en tu laptop, no en el workstation):**
> tras autorizar, el navegador redirige a `http://localhost:PUERTO/?code=...` y muestra una página
> en blanco/error (ese `localhost` es tu laptop, no el contenedor donde clasp espera). El login
> queda a medias. **Solución:** copia esa URL completa y, en **otra terminal del contenedor**
> (clasp sigue esperando), entrégasela a clasp con curl:
> ```bash
> curl "http://localhost:PUERTO/?code=...(la URL completa que copiaste)..."
> ```
> Debe responder `Logged in! You may close this page.` Verifica con `clasp show-authorized-user`.
> (Alternativa: reenviar ese PUERTO en el panel **Ports** de VS Code antes de autorizar.)
> El `code` es de un solo uso y caduca en minutos — no lo compartas ni lo reutilices.

🖥️ **Habilitar la Apps Script API:** abre https://script.google.com/home/usersettings y actívala.
**Para qué:** sin esto, `clasp create`/`push` fallan. Se hace una sola vez por cuenta.

```bash
cd ~/Projects/CoS-Agent
cp cos.config.example.json cos.config.json
```
**Para qué:** crear tu config local (gitignored) donde anotarás los IDs a medida que los obtengas.
Ábrelo en VS Code (clic en `cos.config.json` en el explorador); en la sección siguiente te digo
qué va en cada campo.

---

## Configurar `cos.config.json` (tu hoja de referencia)

`cos.config.json` es tu **cuaderno de IDs** — Apps Script **no lo lee**. Lo que de verdad conecta
el runtime es `appsscript.json` (el `libraryId`) y `config.js`. Por eso el Script ID de la librería
lo pegarás en **dos** lugares. Aquí solo lo anotas para tenerlo a mano.

**Cómo editarlo:** ábrelo en VS Code y ve llenando los campos en los pasos 1 y 2.

| Campo en `cos.config.json` | Qué pegar | De dónde sale | ⚠️ ¿Va también en otro lado? |
|---|---|---|---|
| `library.scriptId` | Script ID de la librería | Paso 1 (`clasp create` / `cat shared/.clasp.json`) | **Sí** → `workflows/CLEVEL-REPORTS/appsscript.json` → `libraryId` (esto es lo que conecta el runtime) |
| `library.version` | `"1"` | Paso 1 (tras `clasp create-version`) | **Sí** → `appsscript.json` → `version` |
| `template.sheetId` | Sheet ID de la plantilla | Paso 2 (`clasp create --type sheets`) | No — solo para armar el link `/copy` que repartes |
| `template.copyUrlHint` | reemplaza `<SHEET_ID>` por el Sheet ID | Paso 2 | No |
| `gemini.modelPerRow` / `modelConsolidated` | ya vienen puestos | — | Si los cambias, cámbialos también en `config.js` (el runtime lee de ahí) |
| `runtime.*` | ya vienen puestos | — | Espejo de `config.js` (referencia) |

**Cómo se ve al final** (con tus IDs reales):

```json
{
  "library":  { "scriptId": "1AbC...tuScriptIdReal", "identifier": "CoSLib", "version": "1" },
  "template": {
    "sheetId": "1XyZ...tuSheetId",
    "copyUrlHint": "https://docs.google.com/spreadsheets/d/1XyZ...tuSheetId/copy"
  },
  "gemini":   { "modelPerRow": "gemini-3.6-flash", "modelConsolidated": "gemini-3.1-pro-preview" },
  "runtime":  {
    "timezone": "America/Lima", "dispatchWindowMin": 5,
    "sheets": { "daily": "Daily", "weekly": "Weekly", "roster": "Equipo", "prompts": "Prompts", "settings": "Ajustes" }
  }
}
```

> Puedes borrar las claves `"//..."` (son solo comentarios).

---

## 1. Subir la LIBRERÍA (lógica + key)

```bash
cd ~/Projects/CoS-Agent/shared
```
**Para qué:** entrar a la carpeta con el código de la librería (los 10 `.js` + `appsscript.json`).

```bash
clasp create --type standalone --title "CLEVEL-REPORTS-Lib"
```
**Para qué:** crear el **proyecto standalone** de la librería en tu Drive. Genera un `.clasp.json`
local con su **Script ID** (lo necesitarás en el paso 2).

```bash
clasp push --force
```
**Para qué:** subir todo el código de `shared/` al proyecto (queda en HEAD, la versión de trabajo).

```bash
cat .clasp.json
```
**Para qué:** ver el **Script ID** de la librería (campo `scriptId`).
📋 **Cópialo y pégalo en 2 sitios:** (1) `cos.config.json` → `library.scriptId`; (2) más adelante en
`workflows/CLEVEL-REPORTS/appsscript.json` → `libraryId` (paso 2, "Cablear"). Después de
`clasp create-version`, pon también `library.version: "1"` en `cos.config.json`.

```bash
clasp open-script
```
**Para qué:** abrir el editor de la librería en el navegador para el siguiente paso (la key).

🖥️ **Poner la key + probar (en el editor que se abrió):**
Configuración del proyecto (⚙️) → Propiedades del script → agrega `GEMINI_API_KEY` = tu key.
Luego Ejecutar → `smokeTestGemini` (autoriza el servicio externo) → el Registro debe decir
`OK CoS v0.5`.
**Para qué:** la key vive **solo aquí** (oculta); el smoke confirma que Gemini responde.

```bash
clasp create-version "v0.5.0 - libreria inicial"
```
**Para qué:** congelar la **versión 1** (inmutable) de la librería. Los stubs apuntan a una versión
fija, no a HEAD, para tener estabilidad.

```bash
clasp list-versions
```
**Para qué:** confirmar que la versión 1 quedó creada.

---

## 2. Subir la PLANTILLA (el Sheet + stub que copian los líderes)

```bash
cd ~/Projects/CoS-Agent/workflows/CLEVEL-REPORTS
```
**Para qué:** entrar a la carpeta del stub (config.js, stub.js, triggers.js). El `Sidebar.html`
vive en `shared/` (lo sirve la librería), no aquí.

```bash
clasp create --type sheets --title "CoS — Plantilla CLEVEL-REPORTS"
```
**Para qué:** crear un **Sheet nuevo + su script bound** (la plantilla).
📋 De la URL que imprime (`.../spreadsheets/d/SHEET_ID/edit`) copia el **Sheet ID** y pégalo en
`cos.config.json` → `template.sheetId`, y dentro de `template.copyUrlHint` (reemplaza `<SHEET_ID>`).
También lo ves con `cat .clasp.json` (campo `parentId`).

🖥️ **Cablear la librería en el stub:** edita `appsscript.json` y reemplaza
`REEMPLAZAR_CON_SCRIPT_ID_DE_LA_LIBRERIA` por el **Script ID de la librería** (paso 1). Deja
`"version": "1"`.
**Para qué:** le dice al stub qué librería usar (`CoSLib`) y en qué versión.

```bash
clasp push --force
```
**Para qué:** subir el stub + el manifiesto ya cableado al script bound del Sheet.

🖥️ **Autorizar + activar (en el Sheet):** ábrelo → Extensiones → Apps Script → ejecuta
`setupTriggers` una vez y autoriza los permisos.
**Para qué:** instala los activadores `onFormSubmit` y `dispatcher` (cada 5 min). Sin esto la
automatización no corre.

🖥️ **Tras generar cada Form:** ponlo en *Recopilar direcciones de correo → **Verificado*** (2 clics,
ver 2b).
**Para qué:** que el Form no muestre la casilla "Correo". Es un paso **manual y esperado**, no un
síntoma de que algo falló.

---

## 2b. Correo verificado en los Forms (paso manual)

El Form **no** pregunta nombre ni correo: Google toma el correo de la sesión del respondiente
(modo **Verificado**) y la librería lo cruza contra la pestaña `Equipo` para rellenar `Nombre` y
`Correo` en `Daily`/`Weekly`. Ver
[CLEVEL-REPORTS.md#contrato-de-datos](workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md#contrato-de-datos).

🖥️ **El paso, en el Form recién generado:** **Configuración** → *Respuestas* → **Recopilar
direcciones de correo** → **Verificado**. Una vez por Form (Daily y Weekly), por líder.

**Por qué es manual.** `FormApp` no expone el modo de recolección: solo tiene
`setCollectEmail(true)`, que activa la recolección en modo "entrada del encuestado" — justamente la
casilla que queremos quitar. El único camino programático es la **Forms REST API**
(`emailCollectionType: VERIFIED`), y esa API exige un **proyecto Cloud estándar**: con el proyecto
por defecto que Apps Script crea solo, no se puede habilitar.

> ⚠️ Y el proyecto que cuenta es el del **stub**, no el de la librería. Aunque el código viva en
> `CoSLib`, una librería no tiene identidad propia en runtime: la llamada se ejecuta con el token
> del script que la invoca, y quien aprieta "Generar Form" es el líder desde su sidebar. Como cada
> copia del Sheet nace con un proyecto Cloud por defecto nuevo, habilitarla sería un trámite de GCP
> **por cada líder** — más caro que los 2 clics. Por eso se dejó manual.
>
> *(Tampoco existe un servicio avanzado de Forms en Apps Script que evite el trámite: la lista
> incluye Docs, Drive, Sheets y Slides, pero Forms solo está como servicio integrado `FormApp`.)*

El código **ya intenta** el modo verificado por REST y es best-effort: si falla, el Form se genera
igual y sigue recogiendo el correo — solo queda la casilla y el motivo en el log. Así que si algún
día el stub corre sobre un proyecto Cloud estándar con la Forms API habilitada, el paso manual
desaparece solo, sin tocar código.

```bash
clasp tail-logs   # desde workflows/CLEVEL-REPORTS/
```
**Para qué:** ver si hizo falta el paso manual. `No se pudo poner el correo en modo VERIFICADO
(HTTP 403 …)` = aplica los 2 clics.

---

## 2c. Publicación y acceso de los Forms (automático)

Esto **sí** lo resuelve el código, y conviene saber por qué existe: los Forms creados por API
después del **30-jun-2026** nacen en estado **no publicado**. Un Form no publicado deja al equipo
con *"necesitas acceso"* al abrir la invitación — y falla **en silencio**, porque el correo sale
igual.

`sincronizarAccesoForm_` lo cubre al generar cada Form:

1. `form.setPublished(true)` — publica (reemplaza a `setAcceptingResponses`).
2. `form.addPublishedReaders(correos de Equipo)` — acceso de **respondiente**, no de editor.

Ambos van protegidos por `supportsAdvancedResponderPermissions()`: los Forms antiguos no soportan
ese modelo y llamarlos ahí lanza error.

También se re-sincroniza al pulsar **Guardar equipo**, para que quien entre al equipo después no
tenga que esperar a que se regeneren los Forms. **No se quita** a quien sale: revocar acceso es
manual, en el propio Form.

```
Ejecutar → diagnostico   (en el editor del stub, y revisar Ver → Registro)
```
**Para qué:** confirmar el acceso sin adivinar. Imprime por Form
`publicado=… | soporta publicación=… | respondientes=N`.

---

## 3. Verificar

```bash
clasp tail-logs
```
**Para qué:** ver en vivo los logs de ejecución (útil si un activador falla). Ejecútalo desde la
carpeta del proyecto que quieras inspeccionar (`shared/` o el stub).

Luego sigue el **checklist de smoke** (enviar un Form de prueba, consolidados, invitaciones) de
[installation.md](installation.md#h-checklist-de-smoke-manual).

---

## Secuencia mínima (todo junto)

```bash
# Librería
cd ~/Projects/CoS-Agent/shared
clasp create --type standalone --title "CLEVEL-REPORTS-Lib"
clasp push --force
cat .clasp.json                 # copia el scriptId
# 🖥️ pon GEMINI_API_KEY + corre smokeTestGemini en el editor
clasp create-version "v0.5.0"

# Plantilla
cd ~/Projects/CoS-Agent/workflows/CLEVEL-REPORTS
clasp create --type sheets --title "CoS — Plantilla CLEVEL-REPORTS"
# 🖥️ edita appsscript.json: libraryId = scriptId de la librería
clasp push --force
# 🖥️ en el Sheet: ejecuta setupTriggers y autoriza
# 🖥️ genera los Forms desde el sidebar y pon cada uno en
#    Configuración → Recopilar direcciones de correo → Verificado (ver 2b)
```

## Después: publicar un cambio

```bash
cd ~/Projects/CoS-Agent/shared
clasp push                      # sube el cambio a HEAD
# probar (npm test + smoke)
clasp create-version "v0.5.1 - descripcion"
# 🖥️ sube "version" en el appsscript.json de los stubs y clasp push del stub
```
**Para qué:** `push` solo cambia HEAD; hasta que **no** creas una versión nueva y apuntas los stubs
a ella, los líderes siguen estables en la versión anterior.
