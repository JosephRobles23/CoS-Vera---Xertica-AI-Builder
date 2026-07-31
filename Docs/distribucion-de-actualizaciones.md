# Distribución de actualizaciones — limitante actual y opciones

Este documento registra **por qué la auto-actualización desde el menú no funciona** con el modelo
actual (librería + stub container-bound), qué se intentó, y qué requiere cada alternativa —
especialmente los **requerimientos de acceso/permisos** y **lo que debe hacer el admin de
Workspace** para la Opción B (Editor Add-on).

> Estado: `Blocked`. El botón "Actualizar CoS a la última versión" está implementado en el código
> (`shared/update-runtime.js`, `stub.js`, scope `script.projects`) pero **no es viable en producción**
> por la limitante descrita abajo. Ninguna opción de desbloqueo se ha adoptado aún.

---

## 1. El objetivo

Entregar a cada líder (C-level) **nuevas versiones de lógica y de UI sin que tenga que**:

- entrar a Apps Script,
- re-copiar el Sheet, ni
- perder su configuración (pestaña `Ajustes`, `Equipo`, `Prompts`, Forms, triggers).

Gracias al **bootloader** (menú, sidebar y diálogos ya viven en la librería `CoSLib`), lo único que
una copia necesita para recibir una actualización es **avanzar la versión de librería fijada** en su
`appsscript.json` (`dependencies.libraries[0].version`) — un cambio de **una línea**. El problema es
cómo mover ese número sin fricción para el C-level.

---

## 2. La limitante (por qué el botón de auto-update no funciona)

El botón llamaba a la **Apps Script REST API** (`script.googleapis.com`) desde dentro del stub, con
el token de `ScriptApp.getOAuthToken()`, para reescribir el `appsscript.json` de la propia copia.

Al probarlo, la API devuelve **`403 PERMISSION_DENIED` / `SERVICE_DISABLED`**:

```
Apps Script API has not been used in project 573231223668 before or it is disabled.
Enable it by visiting https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=573231223668
reason: SERVICE_DISABLED
```

### Por qué pasa (dos "habilitaciones" distintas)

| Habilitación | Qué cubre | ¿Sirve para el botón? |
|---|---|---|
| Toggle en `script.google.com/home/usersettings` ("Google Apps Script API: ON") | Acceso estilo **clasp** (usa la infraestructura de Google) | ❌ No cubre esta ruta |
| Habilitar `script.googleapis.com` en el **proyecto GCP de la copia** | Llamadas hechas **desde el script** (`UrlFetchApp` + `getOAuthToken`) | ✅ Sí, pero ver candados |

Cuando la API se llama **desde dentro del script**, la llamada se atribuye al **proyecto de Google
Cloud de la copia** (el número que aparece en el error, p. ej. `573231223668`) y ahí
`script.googleapis.com` **no está habilitada**. El toggle de usersettings — aunque esté ON — **no
cubre** esta ruta. Por eso `clasp` sí funciona y el botón no.

### Por qué no se puede "simplemente habilitarla"

- Es el **proyecto GCP por defecto** (auto-creado) de cada copia. Google suele **bloquear** habilitar
  APIs en proyectos por defecto, y **no tenemos acceso** a ese proyecto GCP.
- Aunque se pudiera, **cada líder** tendría que hacerlo en su copia (mucha fricción), y **una copia
  nueva nace con otro proyecto por defecto** → no se hereda. Inviable para C-levels.

### Diagnóstico reproducible

Pegar en el editor de la copia y ejecutar; ambas llamadas dan `403 SERVICE_DISABLED` con el número
del proyecto GCP:

```js
function diagUpdate() {
  var token = ScriptApp.getOAuthToken();
  var self  = ScriptApp.getScriptId();
  var lib   = '1ywuYbBTxVePDUvbpez6lVyl7W1IW7cBnQQVhw6etOf8eZIXD5zT_wKyx';
  var base  = 'https://script.googleapis.com/v1/projects/';
  function call(nombre, url) {
    var r = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token } });
    Logger.log('[' + nombre + '] ' + r.getResponseCode() + '\n' + r.getContentText().slice(0, 600));
  }
  call('1-leer-mi-copia',      base + encodeURIComponent(self) + '/content');
  call('2-versiones-libreria', base + encodeURIComponent(lib)  + '/versions');
}
```

---

## 3. Opciones de desbloqueo

### Opción A — Push del dev por clasp (pragmática, sin cambios de plataforma)

El admin/dev promueve la actualización empujando el `appsscript.json` (versión bumpeada) a cada copia
por su `scriptId`, con `clasp push`. El C-level solo **recarga la hoja**.

**Requerimientos de acceso/permisos:**
- La cuenta admin de CoS con **`clasp` logueado** y la **Apps Script API ON** en *su* usersettings.
- **Acceso de EDITOR** de la cuenta admin sobre **cada copia** (one-time: el líder comparte su copia,
  acción de "Compartir" normal).
- Una **lista mantenida de `scriptId`** de las copias (el Script ID vive en la copia →
  Extensiones → Apps Script → ⚙️ Configuración del proyecto).

**Fricción:** cero por release para el C-level; moderada para el admin (una vez el compartir, y un
push por copia en cada release). Escala bien para pocos líderes; mal para muchos.

**Riesgo:** `clasp push --force` **reemplaza todos los archivos de código** de la copia. Es seguro
porque `config.js`/`stub.js`/`triggers.js`/`appsscript.json` son idénticos entre copias (la config de
runtime vive en el Sheet, no en el código). **Nunca** incluir en el push archivos con IDs por-copia.

### Opción B — Migrar a Editor Add-on (definitiva) — ver §4

Actualización **centralizada y automática**: se publica una versión nueva y **todos** la reciben,
sin API por copia, sin GCP por usuario, sin tocar cada copia nunca. Oculta el código de forma
nativa (podría absorber el rol de la librería). Es la migración que ya anticipa
[architecture-and-contracts.md](architecture-and-contracts.md).

### Opción C — Descartadas

| Alternativa | Por qué se descarta |
|---|---|
| `developmentMode: true` (usar HEAD de la librería sin versión fija) | Requiere **edición** del usuario sobre la librería → **expondría `GEMINI_API_KEY`** (los editores ven Script Properties) y el código. |
| Adjuntar un **proyecto GCP estándar** a las copias | Requiere acceso a GCP (no lo tenemos) y **no se hereda** al copiar; sería por-copia. |
| Que cada líder habilite la API en el GCP de su copia | Proyecto por defecto bloqueado + fricción inaceptable para C-levels. |

---

## 4. Opción B en detalle — requerimientos y rol del admin de Workspace

Un **Editor Add-on / Google Workspace Add-on** publicado como app **privada (interna)** del dominio
@xertica es el camino sin fricción: los usuarios lo obtienen del Workspace y las actualizaciones se
propagan solas.

### 4.1 Requerimientos técnicos (lado publicador — dev/admin)

1. **Un proyecto de Google Cloud (GCP) estándar** — *uno solo*, del lado del publicador (no de cada
   líder). En él se:
   - Habilita la **Google Workspace Marketplace SDK** (y la Apps Script API si aplica).
   - Configura la **OAuth consent screen** como **Internal** (solo el dominio @xertica).
   - Declaran los **scopes** que usa la app (los mismos del stub actual: `spreadsheets`,
     `script.external_request`, `script.send_mail`, `script.scriptapp`, `forms`, `forms.body`,
     `script.container.ui`; **ya no** haría falta `script.projects`).
2. El código se empaqueta como **Add-on** (proyecto Apps Script con `appsscript.json` de tipo add-on:
   manifiesto `addOns` / triggers de Editor como `onOpen`/`onInstall`). La librería `CoSLib` puede
   plegarse dentro del add-on (deja de necesitarse el patrón librería+stub para ocultar código).
3. Publicación en el **Marketplace SDK** como **app privada/interna** (visibilidad restringida al
   dominio). Cada release nueva se publica desde el mismo proyecto y llega a todos.

### 4.2 Lo que debe hacer el **admin de Google Workspace**

> Estos pasos requieren la **Consola de Administración** (`admin.google.com`) — rol de
> **Super Admin** o un rol con privilegios sobre *Apps > Google Workspace Marketplace*.

1. **Permitir/instalar la app privada al dominio.**
   Admin Console → **Apps → Google Workspace Marketplace apps → Apps list → Add app → Add private
   app** (o "Admin install"), seleccionar la app interna publicada y **desplegarla** a toda la
   organización o a una **OU/grupo** (p. ej. solo los C-levels).
2. **Confiar en la app / conceder scopes (OAuth app access control).**
   Admin Console → **Security → API controls → App access control → Manage third-party app access**
   → marcar la app como **Trusted** (por su **OAuth Client ID**). Esto evita la pantalla de
   "app no verificada" y autoriza los scopes a nivel dominio.
3. **(Si se mantienen envíos de correo)** confirmar que la política de Apps Script y de correo
   saliente del dominio permite `MailApp`/`GmailApp` para los usuarios objetivo.
4. **(Recomendado)** acordar una **OU/grupo de piloto** para desplegar primero a un subconjunto y
   luego ampliar.

### 4.3 Qué deja de ser necesario con la Opción B

- El scope `script.projects` en el stub.
- El botón "Actualizar" y todo `shared/update-runtime.js`.
- El **puente por clasp** a cada copia (Opción A) y el mantener acceso de editor + lista de scriptIds.
- Potencialmente el **patrón librería+stub** (el add-on ya oculta el código y centraliza updates).

### 4.4 Costos / consideraciones

- Esfuerzo de **reempaquetado** a add-on y de **publicación** en el Marketplace SDK.
- Requiere un **proyecto GCP** del lado publicador (uno, no por líder) — si la org bloquea crear
  proyectos GCP, el **admin de Workspace** debe habilitarlo o crear el proyecto.
- El `GEMINI_API_KEY` deja de vivir en Script Properties de una librería compartida; hay que decidir
  dónde reside en el modelo add-on (p. ej. propiedades del add-on / backend propio) **sin exponerlo**.

---

## 5. Estado y decisión

- **Hoy:** ninguna opción adoptada. El botón queda implementado pero **no operativo** (muestra el
  error de GCP). Considerar en una **v8** **retirar el botón o volverlo informativo** (mostrar la
  versión actual, sin llamar a la API) para no confundir al C-level.
- **Recomendación:** Opción A como puente de corto plazo (si se acepta el acceso de editor + lista de
  scriptIds); Opción B (Add-on) como solución definitiva de distribución.

> Referencias: modelo de distribución actual en
> [conventions.md](conventions.md#un-stub-container-bound-por-líder) e
> [installation.md](installation.md#i-distribuir-a-otros-líderes); migración futura anticipada en
> [architecture-and-contracts.md](architecture-and-contracts.md#desviación-consciente-de-aos-usamos-una-librería).
