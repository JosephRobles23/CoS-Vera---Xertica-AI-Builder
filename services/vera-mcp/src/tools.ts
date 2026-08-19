/**
 * tools.ts — Los 5 tools MCP de Vera v1. Cada uno resuelve el tenant desde los props del
 * token OAuth (getMcpAuthContext) y proxea al GAS Web App de ESE líder vía gasClient.
 *
 * El tenantId sale SIEMPRE del token (server-side), nunca de los args del modelo → evita
 * el confused-deputy. El modelo (Claude/ChatGPT) produce args estructurados; GAS valida
 * catálogo + dedup (create) y enums/fechas (edit).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';
import type { Env } from './env';
import { getTenant } from './storage';
import { callGas } from './gasClient';

async function resolveTenant(env: Env) {
  const auth = getMcpAuthContext();
  const tenantId = auth?.props?.tenantId as string | undefined;
  if (!tenantId) throw new Error('No autenticado: reconecta el conector de Vera.');
  const tenant = await getTenant(env, tenantId);
  if (!tenant) throw new Error('Conexión no encontrada: vuelve a emparejar desde el sidebar.');
  return tenant;
}

/** Envuelve el resultado como content JSON (el cliente MCP lo parsea/razona). */
function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

async function proxy(env: Env, op: string, args: Record<string, unknown>) {
  const t = await resolveTenant(env);
  return jsonContent(await callGas(t.webAppUrl, t.secret, op, args));
}

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: 'vera', version: '0.1.0' });

  server.registerTool('list_tasks', {
    description: 'Lista las tareas del líder. Excluye las "Hecha" salvo incluirHechas.',
    inputSchema: {
      estado: z.enum(['Pendiente', 'En curso', 'Bloqueada', 'Hecha']).optional(),
      proyecto: z.string().optional(),
      prioridad: z.enum(['Alta', 'Media', 'Baja']).optional(),
      venceDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      venceHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      incluirHechas: z.boolean().optional()
    }
  }, async (args) => proxy(env, 'list_tasks', args));

  server.registerTool('search_wiki', {
    description: 'Busca en el second brain curado (proyectos, reuniones, personas). Devuelve páginas crudas para que razones sobre ellas.',
    inputSchema: {
      query: z.string(),
      tipo: z.enum(['projects', 'meetings', 'people', 'all']).optional()
    }
  }, async (args) => proxy(env, 'search_wiki', args));

  server.registerTool('get_catalog', {
    description: 'Catálogo de nombres válidos de proyectos y personas. Úsalo antes de create_task para resolver nombres.',
    inputSchema: {}
  }, async () => proxy(env, 'get_catalog', {}));

  server.registerTool('create_task', {
    description: 'Crea una tarea. Si ya existe una muy similar y no pasas force, devuelve {duplicate, similar}; reenvía con force:true para crear de todas formas.',
    inputSchema: {
      texto: z.string().min(1),
      proyecto: z.string().optional(),
      espera: z.string().optional(),
      vence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      prioridad: z.enum(['Alta', 'Media', 'Baja']).optional(),
      force: z.boolean().optional()
    }
  }, async (args) => proxy(env, 'create_task', args));

  server.registerTool('edit_task', {
    description: 'Edita una tarea existente por su id (el que devuelve list_tasks). Solo envía los campos a cambiar.',
    inputSchema: {
      id: z.string().min(1),
      campos: z.object({
        texto: z.string().optional(),
        proyecto: z.string().optional(),
        vence: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
        prioridad: z.enum(['Alta', 'Media', 'Baja']).optional(),
        estado: z.enum(['Pendiente', 'En curso', 'Bloqueada', 'Hecha']).optional(),
        espera: z.string().optional(),
        link: z.string().optional()
      })
    }
  }, async (args) => proxy(env, 'edit_task', args));

  return server;
}
