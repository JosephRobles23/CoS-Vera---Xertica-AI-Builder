# Onboarding — habilitar CoS a un nuevo líder

Cómo darle la automatización a otra persona (otro correo). Hay **dos roles**: lo que haces **tú
(admin/dev)** una sola vez, y lo que hace **el nuevo líder** en su navegador (sin instalar nada).

> Modelo: una **librería compartida** (lógica + `GEMINI_API_KEY`) + una **plantilla** (Sheet con el
> stub) que cada líder **copia** y autoriza con su cuenta. Cada líder corre su propia copia.

---

## Requisitos

- La persona tiene una cuenta Google (idealmente **@xertica.com**).
- La librería `CLEVEL-REPORTS-Lib` ya existe y tiene el `GEMINI_API_KEY` puesto (una sola vez, ya hecho).

---

## Parte A — Preparación (tú, admin) · una vez por versión

### A1. Congela una versión de la librería con el código actual
```bash
cd ~/Projects/CoS-Agent/shared
clasp push --force
clasp create-version "v0.5 distribución"
clasp list-versions        # anota el número MÁS ALTO (p.ej. 3)
```

### A2. ⚠️ Apunta la plantilla a esa versión y DESACTIVA developmentMode
Esto es lo más importante. `developmentMode: true` **solo funciona para ti** (dueño de la
librería). Los demás tienen acceso de **lectura** → deben usar una **versión fija**.

Edita `workflows/CLEVEL-REPORTS/appsscript.json`:
```json
"libraries": [{
  "userSymbol": "CoSLib",
  "libraryId": "1ywuYbBTxVePDUvbpez6lVyl7W1IW7cBnQQVhw6etOf8eZIXD5zT_wKyx",
  "version": "3",           // ← el número del paso A1
  "developmentMode": false  // ← OBLIGATORIO para otros líderes
}]
```
Sube la plantilla:
```bash
cd ~/Projects/CoS-Agent/workflows/CLEVEL-REPORTS
clasp push --force
```

### A3. Deja la plantilla LIMPIA
La copia hereda el contenido del Sheet plantilla. Antes de compartir, en el Sheet plantilla:
- **Equipo:** vacío (solo encabezados).
- **Ajustes:** borra las filas `forms.*` y `leader.*` (o borra toda la pestaña; se regenera con
  defaults). Así el nuevo líder genera **sus propios** Forms y no hereda los tuyos.
- **Daily / Weekly:** borra respuestas de prueba.

### A4. Comparte la librería (solo lectura)
En Drive → abre `CLEVEL-REPORTS-Lib` → **Compartir** → agrega a la persona (o al dominio
**@xertica.com** o a un **Grupo**) como **Lector**. Sin esto, su copia **no puede** usar `CoSLib`.

### A5. (Recomendado) Evita el aviso "app no verificada"
Pide al **admin de Google Workspace** que confíe en la app (allowlist por *OAuth Client ID*). Si no,
el líder verá una advertencia al autorizar (puede continuar con **Configuración avanzada**).

> Si allowlisteas por scopes, incluye los del stub: `spreadsheets`, `script.external_request`,
> `script.send_mail`, `script.scriptapp`, `forms`, `forms.body`, `script.container.ui`.

### A6. Comparte el enlace de copia
Manda este link a la persona (fuerza "Hacer una copia"):
```
https://docs.google.com/spreadsheets/d/1sJKQkZFihg5gNc7YyG4OgEH6cSssKFmC1whBxklDW2Q/copy
```

---

## Parte B — Lo que hace el nuevo líder (en su navegador)

1. Abre el enlace → **Hacer una copia** (queda en **su** Drive). No descarga ni instala nada.
2. Abre su copia → recarga la página → aparece el menú **CoS**.
3. **CoS → Configurar** y en el sidebar guarda cada panel:
   - **Equipo:** nombre, correo y rol de cada miembro → *Guardar equipo*. El **correo** debe ser la
     cuenta de Google con la que la persona realmente inicia sesión: es la llave con la que cada
     respuesta recupera su `Nombre`. Si no coincide, la fila queda identificada solo por correo.
   - **Horarios:** su **zona horaria**, horas de invitación y de cierre (Daily/Weekly), y su
     **nombre/correo** (recibe los consolidados) → *Guardar horarios y líder*.
   - **Prompts:** en blanco = usa los defaults, o personaliza → *Guardar prompts*.
4. **CoS → Formularios** abre el modal de preguntas. Para **Daily** y para **Weekly**:
   - Edita las preguntas a mano (pestaña **Preguntas**: tipo, enunciado, opciones, obligatoriedad,
     ayuda, reordenar) **o** pega un prompt en **Generative Form** y pulsa **Generar** para que la IA
     las cree; revisa con **Preview**.
   - Pulsa **Guardar / actualizar Form** → crea (o reescribe el mismo) formulario bajo su cuenta.
     > 🖥️ **Un paso manual en cada Form recién creado:** ábrelo → **Configuración** → *Respuestas*
     > → **Recopilar direcciones de correo** → **Verificado**. Son 2 clics, una vez por Form.
     > Sin esto el Form muestra una casilla "Correo" de más: el nombre y el correo **no** se
     > preguntan, salen de la cuenta de Google de quien responde y se cruzan con la pestaña
     > `Equipo`. Por qué es manual: [deploy-terminal.md#2b](deploy-terminal.md).
6. **Activar la automatización:** *Extensiones → Apps Script* → función **`setupTriggers`** →
   **Ejecutar** → **autorizar** los permisos con su correo (Sheets, correo, servicio externo, Forms).
7. (Opcional) Ejecutar **`estilizarPestanas`** una vez para dar formato a las pestañas.

Listo: la automatización corre **como esa persona** — los correos salen de su cuenta y la cuota es
suya. La `GEMINI_API_KEY` es central (en la librería), así que **no** necesita ninguna key propia.

---

## Parte C — Actualizaciones sin re-copiar (las hace el admin)

La UI (menú, sidebar, modal, diálogos) y la lógica viven en la **librería**, así que las mejoras
llegan **sin** volver a copiar el Sheet. Ya **no** hay botón de auto-actualización (se retiró en la
v8 por una limitante de la plataforma, ver
[distribucion-de-actualizaciones.md](distribucion-de-actualizaciones.md)); el **admin** promueve cada
release con `clasp push` a cada copia (Opción A).

**Una vez por líder** (en el onboarding), para que el admin pueda empujar:
1. El líder comparte su copia con la **cuenta admin** como **Editor** (Compartir normal).
2. El admin anota el **Script ID** de la copia (en la copia → *Extensiones → Apps Script → ⚙️
   Configuración del proyecto*).

**Cada vez que publiques una versión nueva** (ver A1), el admin, por cada copia:
- `clasp push --force` del `appsscript.json` (con el `version` bumpeado) al `scriptId` de la copia.
- El líder solo **recarga la hoja**.

Su configuración (Ajustes/Prompts/Equipo/Forms/activadores) vive en el **Sheet**, no en el código, así
que el push **no la toca**: solo cambia a qué versión de la librería apunta la copia.

> ⚠️ `clasp push --force` reemplaza **todos** los archivos de código de la copia. Es seguro porque
> `config.js`/`stub.js`/`triggers.js`/`appsscript.json` son idénticos entre copias. **Nunca** incluir
> en el push archivos con IDs por-copia.

---

## Verificación rápida

- En **Activadores** (⏰, panel izquierdo del editor) deben existir `onFormSubmit` y
  `dispatcher (cada 5 min)`.
- Prueba: pon `invitesDaily` unos minutos adelante (día L–V), espera a que corra el `dispatcher`
  → llega la invitación al equipo. (Para reintentar el mismo día, corre `limpiarGuardas`.)

---

## Solución de problemas

| Síntoma | Causa / arreglo |
|---|---|
| El sidebar no carga (o error `CoSLib`) | La librería no está compartida con esa persona (**A4**), o quedó `developmentMode: true` (**A2**). |
| "Google no ha verificado esta app" | Falta el allowlist del admin (**A5**); o continuar con *Configuración avanzada → Ir a…*. |
| No salen correos | No ejecutó `setupTriggers`, no ha llegado la hora, o no generó el Form. |
| Al generar el Form da error de permisos | La copia heredó tus `forms.*` en `Ajustes` (falta limpiar la plantilla, **A3**). |
| ¿Necesita su propia API key? | No — vive en la **librería** (central). |
| El menú **CoS → Formularios** no abre el modal | La copia apunta a una versión de librería vieja (< v9). El admin empuja la versión nueva (**Parte C**). |
| Empujé la versión nueva pero el líder no ve cambios | Falta **recargar la hoja**; o el `clasp push` fue a otro `scriptId` (**Parte C**). |
| `clasp push` falla con error de acceso | El admin no tiene **Editor** sobre la copia (**Parte C.1**), o falta la Apps Script API ON en *su* usersettings. |

---

## Recordatorio de versionado

Cuando mejores el código: `clasp push` (HEAD de la librería) → `clasp create-version "vX"` → sube el
`version` en el `appsscript.json` de la plantilla y `clasp push`. Esto último solo afecta a las
**copias nuevas** (nacen apuntando a vX).

Las **copias existentes** las actualiza el **admin**: `clasp push` del `appsscript.json` (versión
bumpeada) al `scriptId` de cada copia; el líder solo recarga la hoja (**Parte C**). Como el menú, el
sidebar, el modal y los diálogos viven en la librería, esa actualización también trae la **UI** nueva.
Invariante: *la última versión publicada es producción* — no publiques una versión que no quieras
distribuir. Detalle en [testing-and-deploy.md](testing-and-deploy.md).
