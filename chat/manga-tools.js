// Tool-verb schema + pure reducer for the manga panel domain.
// Same shape as chat/tools.js: each verb is { schema, apply(state, args) -> newState }.
// State: { panels: PanelEntry[], collections: Collection[], queue: QueueItem[] }.
// Pure reducers — never mutate the input state.

const cloneList = (xs) => xs.map((x) => ({ ...x }));

const findPanel = (state, id) => state.panels.findIndex((p) => p.id === id);
const findCollection = (state, id) => state.collections.findIndex((c) => c.id === id);

const TAG_KINDS = ['subject', 'characters', 'mood', 'userTags'];
const SCALAR_TAG_KINDS = ['style', 'composition', 'lighting', 'perspective'];

export const verbs = {
  add_panel: {
    schema: {
      type: 'object',
      required: ['panel'],
      properties: {
        panel: {
          type: 'object',
          required: ['id', 'manga'],
          properties: {
            id: { type: 'string' },
            imageUrl: { type: 'string' },
            imageLocalPath: { type: 'string' },
            thumbnailPath: { type: 'string' },
            imageWidth: { type: 'integer' },
            imageHeight: { type: 'integer' },
            manga: { type: 'string' },
            chapter: { type: ['integer', 'string', 'null'] },
            chapterTitle: { type: 'string' },
            page: { type: ['integer', 'string', 'null'] },
            panelIndex: { type: 'integer' },
            panelCount: { type: 'integer' },
            isSplash: { type: 'boolean' },
            isDoubleSpread: { type: 'boolean' },
            artist: { type: 'string' },
            subject: { type: 'array', items: { type: 'string' } },
            characters: { type: 'array', items: { type: 'string' } },
            complexity: { type: 'integer', minimum: 1, maximum: 5 },
            style: { enum: ['hatched', 'clean', 'sketchy', 'painted', 'mixed', 'unknown'] },
            composition: { enum: ['closeup', 'wide', 'dynamic', 'static', 'splash', 'spread', 'unknown'] },
            lighting: { enum: ['flat', 'dramatic', 'spotlight', 'high-contrast', 'ambient', 'unknown'] },
            perspective: { enum: ['eye-level', 'low-angle', 'high-angle', 'dutch', 'bird', 'worm', 'unknown'] },
            mood: { type: 'array', items: { type: 'string' } },
            techniqueNotes: { type: 'string' },
            whyRare: { type: 'string' },
            discoveryAngle: { enum: ['reverse-image', 'artist-deep-dive', 'fan-archive', 'splash-transition'] },
            sources: { type: 'array', items: { type: 'object' } },
            addedAt: { type: 'string' },
            lastEnrichedAt: { type: 'string' },
            enriched: { type: 'boolean' },
            needsHigherRes: { type: 'boolean' },
            userTags: { type: 'array', items: { type: 'string' } },
            userRating: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
            practiceCount: { type: 'integer', minimum: 0 },
            lastPracticedAt: { type: ['string', 'null'] },
            embeddingsComputed: { type: 'object' },
          },
        },
      },
    },
    apply(state, { panel }) {
      if (!panel.id) throw new Error('panel.id required');
      if (state.panels.some((p) => p.id === panel.id)) throw new Error(`duplicate id: ${panel.id}`);
      const entry = {
        addedAt: new Date().toISOString(),
        practiceCount: 0,
        userTags: [],
        userRating: null,
        lastPracticedAt: null,
        enriched: false,
        embeddingsComputed: { clip: false, miniLM: false },
        ...panel,
      };
      return { ...state, panels: [...state.panels, entry] };
    },
  },

  update_panel: {
    schema: {
      type: 'object',
      required: ['id', 'patch'],
      properties: { id: { type: 'string' }, patch: { type: 'object' } },
    },
    apply(state, { id, patch }) {
      const i = findPanel(state, id);
      if (i < 0) throw new Error(`panel not found: ${id}`);
      const next = [...state.panels];
      next[i] = { ...next[i], ...patch, lastEnrichedAt: new Date().toISOString() };
      return { ...state, panels: next };
    },
  },

  remove_panel: {
    // Soft delete — flip removedAt rather than dropping. Keeps embedding files
    // referenceable; the harvester can prune for real on a later pass.
    schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
    },
    apply(state, { id, reason = '' }) {
      const i = findPanel(state, id);
      if (i < 0) throw new Error(`panel not found: ${id}`);
      const next = [...state.panels];
      next[i] = { ...next[i], removedAt: new Date().toISOString(), removedReason: reason };
      return { ...state, panels: next };
    },
  },

  tag_panel: {
    schema: {
      type: 'object',
      required: ['id', 'kind', 'value'],
      properties: {
        id: { type: 'string' },
        kind: { enum: [...TAG_KINDS, ...SCALAR_TAG_KINDS] },
        value: {},
      },
    },
    apply(state, { id, kind, value }) {
      const i = findPanel(state, id);
      if (i < 0) throw new Error(`panel not found: ${id}`);
      const panel = { ...state.panels[i] };
      if (SCALAR_TAG_KINDS.includes(kind)) {
        panel[kind] = value;
      } else {
        const list = Array.isArray(panel[kind]) ? panel[kind] : [];
        if (!list.includes(value)) panel[kind] = [...list, value];
      }
      const next = [...state.panels];
      next[i] = panel;
      return { ...state, panels: next };
    },
  },

  set_practice_meta: {
    schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        practiceCount: { type: 'integer', minimum: 0 },
        lastPracticedAt: { type: 'string' },
        userRating: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
      },
    },
    apply(state, { id, ...patch }) {
      const i = findPanel(state, id);
      if (i < 0) throw new Error(`panel not found: ${id}`);
      const next = [...state.panels];
      next[i] = { ...next[i], ...patch };
      return { ...state, panels: next };
    },
  },

  create_collection: {
    schema: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            panelIds: { type: 'array', items: { type: 'string' } },
            intendedFor: { enum: ['10-min-challenge', 'mood-board', 'study-set', 'freeform'] },
            filter: { type: 'object' },
          },
        },
      },
    },
    apply(state, { collection }) {
      if (findCollection(state, collection.id) >= 0) throw new Error(`collection exists: ${collection.id}`);
      const c = {
        panelIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...collection,
      };
      return { ...state, collections: [...state.collections, c] };
    },
  },

  delete_collection: {
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    apply(state, { id }) {
      const i = findCollection(state, id);
      if (i < 0) throw new Error(`collection not found: ${id}`);
      const next = [...state.collections];
      next.splice(i, 1);
      return { ...state, collections: next };
    },
  },

  add_to_collection: {
    schema: {
      type: 'object',
      required: ['collectionId', 'panelId'],
      properties: { collectionId: { type: 'string' }, panelId: { type: 'string' } },
    },
    apply(state, { collectionId, panelId }) {
      const ci = findCollection(state, collectionId);
      if (ci < 0) throw new Error(`collection not found: ${collectionId}`);
      if (findPanel(state, panelId) < 0) throw new Error(`panel not found: ${panelId}`);
      const next = cloneList(state.collections);
      const ids = next[ci].panelIds || [];
      if (!ids.includes(panelId)) next[ci] = { ...next[ci], panelIds: [...ids, panelId], updatedAt: new Date().toISOString() };
      return { ...state, collections: next };
    },
  },

  remove_from_collection: {
    schema: {
      type: 'object',
      required: ['collectionId', 'panelId'],
      properties: { collectionId: { type: 'string' }, panelId: { type: 'string' } },
    },
    apply(state, { collectionId, panelId }) {
      const ci = findCollection(state, collectionId);
      if (ci < 0) throw new Error(`collection not found: ${collectionId}`);
      const next = cloneList(state.collections);
      const ids = (next[ci].panelIds || []).filter((p) => p !== panelId);
      next[ci] = { ...next[ci], panelIds: ids, updatedAt: new Date().toISOString() };
      return { ...state, collections: next };
    },
  },

  start_practice_session: {
    // Read-only — picks N panels matching `filter`, returns ephemeral session
    // bound to state. Does NOT mutate corpus. Caller wraps it in their own UX.
    schema: {
      type: 'object',
      required: ['count', 'durationMin'],
      properties: {
        filter: { type: 'object' },
        count: { type: 'integer', minimum: 1, maximum: 50 },
        durationMin: { type: 'number', minimum: 0.5, maximum: 60 },
      },
    },
    apply(state, { filter = {}, count, durationMin }) {
      const pool = state.panels.filter((p) => !p.removedAt && matchesFilter(p, filter));
      const shuffled = pool.slice().sort(() => Math.random() - 0.5);
      const session = {
        sessionId: `practice-${Date.now()}`,
        durationMinPerPanel: durationMin,
        panels: shuffled.slice(0, count).map((p) => ({ id: p.id, imageLocalPath: p.imageLocalPath, manga: p.manga })),
        startedAt: new Date().toISOString(),
      };
      return { ...state, _ephemeral: { ...(state._ephemeral || {}), lastSession: session } };
    },
  },

  enqueue_research: {
    schema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
        discoveryAngle: { enum: ['reverse-image', 'artist-deep-dive', 'fan-archive', 'splash-transition'] },
        reason: { type: 'string' },
        requestedBy: { enum: ['user', 'agent', 'seed'] },
        input: { type: 'object' },
      },
    },
    apply(state, { topic, discoveryAngle, reason = '', requestedBy = 'agent', input }) {
      const queue = Array.isArray(state.queue) ? [...state.queue] : [];
      if (queue.some((q) => q.topic === topic)) return state;
      queue.push({
        topic,
        discoveryAngle: discoveryAngle || 'artist-deep-dive',
        reason,
        requestedBy,
        input: input || null,
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
      });
      return { ...state, queue };
    },
  },

  upsert_corpus: {
    // Generalized upsert used by the harvester. If the entry exists, merge.
    schema: {
      type: 'object',
      required: ['entry'],
      properties: { entry: { type: 'object', required: ['id'] } },
    },
    apply(state, { entry }) {
      if (!entry || !entry.id) throw new Error('entry.id required');
      const i = findPanel(state, entry.id);
      const stamped = { ...entry, lastEnrichedAt: new Date().toISOString() };
      if (i < 0) {
        return verbs.add_panel.apply(state, { panel: stamped });
      }
      const next = [...state.panels];
      next[i] = { ...next[i], ...stamped };
      return { ...state, panels: next };
    },
  },
};

// Filter helper for start_practice_session. Supports exact + array-overlap +
// numeric-min on `complexity`. Add more as the panel taxonomy grows.
function matchesFilter(panel, f) {
  for (const [k, v] of Object.entries(f)) {
    if (k === 'complexity' && typeof v === 'object' && v !== null) {
      if (typeof v.min === 'number' && (panel.complexity ?? 0) < v.min) return false;
      if (typeof v.max === 'number' && (panel.complexity ?? 99) > v.max) return false;
      continue;
    }
    if (Array.isArray(v)) {
      const have = panel[k];
      if (!Array.isArray(have)) return false;
      if (!v.some((x) => have.includes(x))) return false;
      continue;
    }
    if (panel[k] !== v) return false;
  }
  return true;
}

export function apply(state, verb, args) {
  const v = verbs[verb];
  if (!v) throw new Error(`unknown verb: ${verb}`);
  return v.apply(state, args);
}

// Manga is owner-only — only research-enqueue + read-only practice sessions
// could conceivably be exposed to non-owners later. Keep them gated explicitly.
export const READ_ONLY = new Set(['start_practice_session', 'enqueue_research']);

export const VISITOR_FILTER = (verb) => READ_ONLY.has(verb);
