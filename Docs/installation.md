# Installation (paso 4) — desplegar CLEVEL-REPORTS

Guía paso a paso para llevar el código (ya escrito y probado) a Apps Script: crear la **librería**
y la **plantilla**, cablear el `scriptId`, poner la key, publicar versión y validar con smoke tests.

> Requiere tu cuenta de Google. Los comandos `clasp` los corres **tú** en tu terminal
> (con `! clasp ...` para que la salida quede en la sesión). El flujo profundo de push/versión
> está en [testing-and-deploy.md](testing-and-deploy.md).

## Prerrequisitos

1. `clasp` instalado (3.3.0) y sesión iniciada: `! clasp login`.
2. **Habilitar la Apps Script API:** https://script.google.com/home/usersettings → activar.
3. Tener a mano tu **API key de Gemini** (Google AI Studio).
4. Copiar la config local: `cp cos.config.example.json cos.config.json` y completar IDs a medida
   que los obtengas (referencia para ti; los valores de runtime viven en el código/Sheet).

---

## A. Crear la librería (proyecto standalone)

La fuente de la librería es `shared/`.

```bash
cd ~/Projects/CoS-Agent/shared
clasp create --type standalone --title "CLEVEL-REPORTS-Lib"
clasp push --force          # sube los 13 .js + 2 .html + appsscript.json
clasp open-script           # abre el IDE de la librería
```

- Anota el **Script ID** (lo imprime `create`, y está en Project Settings). Es el `libraryId`.
- Guárdalo en `cos.config.json → library.scriptId`.

> Si `create` deja un `Code.js`/`appsscript.json` por defecto, conserva los nuestros y vuelve a
> `clasp push --force`. `.clasp.json` queda en `shared/` (gitignored).

## B. Poner la API key en la librería (Script Properties)

En el IDE de la librería (recién abierto):

1. **⚙️ Configuración del proyecto → Propiedades del script → Agregar propiedad.**
2. Propiedad: `GEMINI_API_KEY` · Valor: tu key.
3. Verifica: ejecuta la función **`smokeTestGemini`** (menú Ejecutar) → el Registro debe mostrar
   `OK CoS v0.5`. La primera vez pedirá autorizar "conectarse a un servicio externo".

## C. Publicar una versión de la librería

Los stubs apuntan a una **versión fija**, no a HEAD.

```bash
cd ~/Projects/CoS-Agent/shared
clasp create-version "v0.5.0 — libreria inicial"
clasp list-versions        # confirma que exista la version 1
```

---

## D. Crear la plantilla (Sheet + stub bound)

La fuente del stub es `workflows/CLEVEL-REPORTS/`.

```bash
cd ~/Projects/CoS-Agent/workflows/CLEVEL-REPORTS
clasp create --type sheets --title "CoS — Plantilla CLEVEL-REPORTS"
```

- Esto crea un **Sheet nuevo** + su script bound. Anota el **Sheet ID** (de la URL) en
  `cos.config.json → template.sheetId`.

## E. Cablear la librería en el stub y subir

1. Edita `workflows/CLEVEL-REPORTS/appsscript.json`: reemplaza
   `REEMPLAZAR_CON_SCRIPT_ID_DE_LA_LIBRERIA` por el **Script ID de la librería** (paso A) y deja
   `"version": "1"`.
2. Sube el stub:

```bash
clasp push --force         # sube config.js, stub.js, triggers.js, appsscript.json (el HTML vive en shared/)
```

## F. Primera autorización + activadores

1. Abre el **Sheet plantilla** (recárgalo) → aparece el menú **CoS**.
2. En **Extensiones → Apps Script**, ejecuta **`setupTriggers`** una vez y **autoriza** los
   permisos (Sheets, correo, servicio externo, Forms, activadores).
3. Verifica en **Activadores** (⏰): deben existir `onFormSubmit` y `dispatcher` (cada 5 min).

---

## G. Configurar desde el sidebar y el modal

En el Sheet, menú **CoS → Configurar** (sidebar). En cada panel, **Guardar**:

1. **Equipo** — nombre, correo y rol de cada miembro.
2. **Horarios** — invitación Daily (L–V), Weekly (viernes), cierre (consolidados) + **líder**
   (nombre y correo que recibe los consolidados).
3. **Prompts** — deja en blanco para usar los defaults, o personaliza `soul`/`user`/tareas.

Luego, menú **CoS → Formularios** (modal), para **Daily** y **Weekly**:

4. **Preguntas** — edítalas a mano (tipo, enunciado, opciones, obligatoriedad, ayuda) **o** genera
   desde un prompt en **Generative Form**; revisa con **Preview** y pulsa **Guardar / actualizar
   Form** (crea/reescribe el Form y guarda su URL en `Ajustes`).

---

## H. Checklist de smoke (manual)

Marca cada uno; ejecuta las funciones desde el editor del **stub** salvo que se indique la librería.

- [ ] **Librería:** `smokeTestGemini` → `OK CoS v0.5` en el Registro.
- [ ] Enviar el **Form Daily** de prueba → en segundos aparece el `Summary` en la fila
      (lo hace `onFormSubmit`; míralo en Ver → Ejecuciones).
- [ ] Sin enviar el Form: `testResumenUltimaFilaDaily` → escribe el `Summary` de la última fila.
- [ ] `testConsolidadoDiario` → llega el **Consolidado Diario** al correo del líder.
- [ ] (viernes) `testConsolidadoSemanal` → llega el **Consolidado Semanal** (correo aparte).
- [ ] **Invitaciones por hora:** en Horarios pon la invitación Daily 2–3 min en el futuro (día
      L–V) y espera al `dispatcher` (o ejecútalo a mano una vez) → llega el correo al equipo
      nombrando al líder.
- [ ] Reejecutar el `dispatcher` en la misma ventana **no** reenvía (guarda anti-dup). Para
      re-probar el mismo día, corre `limpiarGuardas` en el stub.

> Los correos salen de la cuenta que autorizó el stub. Si no llegan, revisa spam y la cuota de
> `MailApp` (100/día gratis; 1500 Workspace).

---

## I. Distribuir a otros líderes

1. **Comparte la librería** con **permiso de lectura** al dominio @xertica.com o a un Grupo
   (necesario para que la copia de cada líder la resuelva en runtime).
2. Da a cada líder el **enlace de copia** de la plantilla: toma la URL del Sheet y cambia el
   final `/edit` por **`/copy`**.
3. Cada líder: **Hacer una copia** → abre su copia → **CoS → Configurar** → autoriza con su
   @xertica → ejecuta `setupTriggers` una vez. Nada que descargar.
4. **Advertencia "app no verificada":** pide al **admin de Workspace** que confíe en la app
   (allowlist por OAuth Client ID) para que nadie la vea. Alternativa: "Configuración avanzada →
   Ir a (no seguro)".

## Promover cambios (después)

Al mejorar la librería: `clasp push` (HEAD) → probar → `clasp create-version "vX"` → subir el
`version` en el `appsscript.json` de los stubs. Ver
[testing-and-deploy.md](testing-and-deploy.md) (Parte 2 — deploy y versionamiento).

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `Falta GEMINI_API_KEY` | No pusiste la propiedad en la **librería** (paso B). |
| `onFormSubmit ... undefined (reading 'range')` | Lo ejecutaste a mano; es un activador. Usa `testResumenUltimaFilaDaily`. |
| El stub no ve `CoSLib` | `libraryId` mal puesto en `appsscript.json`, o falta acceso de lectura a la librería. |
| Invitación sin link | No has generado el Form en el modal **CoS → Formularios** (falta `forms.dailyUrl` en `Ajustes`). |
| El `Summary` no aparece | Encabezados de contrato movidos, o error de red — revisa Ver → Ejecuciones. |
