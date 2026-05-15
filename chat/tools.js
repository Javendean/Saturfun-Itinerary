// Tool-verb schema + pure reducer shared by Mode A (owner writes through Edit)
// and Mode B (visitor reads, never mutates state on disk).
//
// State shape: { itineraryData, corpus, queue }
//   itineraryData = same literal that lives in index.html
//   corpus        = data/corpus/index.json (CorpusEntry[])
//   queue         = data/queue.json
//
// Each verb exports { schema, apply(state, args) -> newState }.
// `apply` is pure: returns a new state object; never mutates the input.

const cloneList = (xs) => xs.map((x) => ({ ...x }));

const findCheckpoint = (state, time) =>
  state.itineraryData.findIndex((c) => c.time === time);

const findPlace = (checkpoint, id) =>
  checkpoint.places.findIndex((p) => p.id === id || p.name === id);

function withCheckpoint(state, time, mutator) {
  const idx = findCheckpoint(state, time);
  if (idx < 0) throw new Error(`unknown checkpoint: ${time}`);
  const next = [...state.itineraryData];
  const cp = { ...next[idx], places: cloneList(next[idx].places) };
  mutator(cp);
  next[idx] = cp;
  return { ...state, itineraryData: next };
}

export const verbs = {
  add_venue: {
    schema: {
      type: 'object',
      required: ['checkpoint', 'place'],
      properties: {
        checkpoint: { type: 'string', description: 'Checkpoint time, e.g. "6:30 PM"' },
        place: {
          type: 'object',
          required: ['id', 'name', 'desc', 'eta', 'url'],
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' },
            eta: { type: 'string' }, url: { type: 'string' },
            originalPhoto: { type: 'string' }, generatedAnim: { type: 'string' },
            duration: { type: 'string' }, zone: { type: 'string' },
            vibe: { type: 'array', items: { type: 'string' } },
            dietary: { type: 'array', items: { type: 'string' } },
            priceBand: { enum: ['$', '$$', '$$$'] },
            isDefault: { type: 'boolean' },
          },
        },
      },
    },
    apply(state, { checkpoint, place }) {
      return withCheckpoint(state, checkpoint, (cp) => {
        if (cp.places.some((p) => p.id === place.id))
          throw new Error(`duplicate id: ${place.id}`);
        cp.places.push(place);
      });
    },
  },

  swap_venue: {
    schema: {
      type: 'object',
      required: ['checkpoint', 'oldId', 'newPlace'],
      properties: { checkpoint: { type: 'string' }, oldId: { type: 'string' }, newPlace: { type: 'object' } },
    },
    apply(state, { checkpoint, oldId, newPlace }) {
      return withCheckpoint(state, checkpoint, (cp) => {
        const i = findPlace(cp, oldId);
        if (i < 0) throw new Error(`venue not found: ${oldId}`);
        cp.places[i] = newPlace;
      });
    },
  },

  remove_venue: {
    schema: {
      type: 'object',
      required: ['checkpoint', 'id'],
      properties: { checkpoint: { type: 'string' }, id: { type: 'string' } },
    },
    apply(state, { checkpoint, id }) {
      return withCheckpoint(state, checkpoint, (cp) => {
        const i = findPlace(cp, id);
        if (i < 0) throw new Error(`venue not found: ${id}`);
        cp.places.splice(i, 1);
      });
    },
  },

  set_default: {
    schema: {
      type: 'object',
      required: ['checkpoint', 'id'],
      properties: { checkpoint: { type: 'string' }, id: { type: 'string' } },
    },
    apply(state, { checkpoint, id }) {
      return withCheckpoint(state, checkpoint, (cp) => {
        let found = false;
        cp.places = cp.places.map((p) => {
          const isMatch = p.id === id || p.name === id;
          if (isMatch) found = true;
          return { ...p, isDefault: isMatch };
        });
        if (!found) throw new Error(`venue not found: ${id}`);
      });
    },
  },

  add_checkpoint: {
    schema: {
      type: 'object',
      required: ['time', 'title', 'description'],
      properties: {
        time: { type: 'string' }, title: { type: 'string' },
        description: { type: 'string' },
        places: { type: 'array', default: [] },
      },
    },
    apply(state, { time, title, description, places = [] }) {
      if (findCheckpoint(state, time) >= 0) throw new Error(`checkpoint exists: ${time}`);
      return { ...state, itineraryData: [...state.itineraryData, { time, title, description, places }] };
    },
  },

  remove_checkpoint: {
    schema: { type: 'object', required: ['time'], properties: { time: { type: 'string' } } },
    apply(state, { time }) {
      const idx = findCheckpoint(state, time);
      if (idx < 0) throw new Error(`unknown checkpoint: ${time}`);
      const next = [...state.itineraryData];
      next.splice(idx, 1);
      return { ...state, itineraryData: next };
    },
  },

  reorder_checkpoint: {
    schema: {
      type: 'object',
      required: ['time', 'newPosition'],
      properties: { time: { type: 'string' }, newPosition: { type: 'integer', minimum: 0 } },
    },
    apply(state, { time, newPosition }) {
      const idx = findCheckpoint(state, time);
      if (idx < 0) throw new Error(`unknown checkpoint: ${time}`);
      const next = [...state.itineraryData];
      const [cp] = next.splice(idx, 1);
      next.splice(Math.min(newPosition, next.length), 0, cp);
      return { ...state, itineraryData: next };
    },
  },

  add_tag: {
    schema: {
      type: 'object',
      required: ['id', 'kind', 'value'],
      properties: {
        id: { type: 'string' },
        kind: { enum: ['vibe', 'dietary', 'zone'] },
        value: { type: 'string' },
      },
    },
    apply(state, { id, kind, value }) {
      let touched = false;
      const itineraryData = state.itineraryData.map((cp) => ({
        ...cp,
        places: cp.places.map((p) => {
          if (p.id !== id && p.name !== id) return p;
          touched = true;
          if (kind === 'zone') return { ...p, zone: value };
          const list = Array.isArray(p[kind]) ? p[kind] : [];
          return list.includes(value) ? p : { ...p, [kind]: [...list, value] };
        }),
      }));
      if (!touched) throw new Error(`venue not found: ${id}`);
      return { ...state, itineraryData };
    },
  },

  set_field: {
    schema: {
      type: 'object',
      required: ['id', 'field', 'value'],
      properties: {
        id: { type: 'string' },
        field: { enum: ['duration', 'priceBand', 'zone', 'eta', 'desc', 'url', 'originalPhoto', 'generatedAnim'] },
        value: {},
      },
    },
    apply(state, { id, field, value }) {
      let touched = false;
      const itineraryData = state.itineraryData.map((cp) => ({
        ...cp,
        places: cp.places.map((p) => {
          if (p.id !== id && p.name !== id) return p;
          touched = true;
          return { ...p, [field]: value };
        }),
      }));
      if (!touched) throw new Error(`venue not found: ${id}`);
      return { ...state, itineraryData };
    },
  },

  upsert_corpus: {
    schema: {
      type: 'object',
      required: ['entry'],
      properties: { entry: { type: 'object', required: ['id', 'name'] } },
    },
    apply(state, { entry }) {
      const corpus = Array.isArray(state.corpus) ? [...state.corpus] : [];
      const i = corpus.findIndex((c) => c.id === entry.id);
      const merged = { ...(i >= 0 ? corpus[i] : {}), ...entry, lastResearchedAt: new Date().toISOString() };
      if (i >= 0) corpus[i] = merged; else corpus.push(merged);
      return { ...state, corpus };
    },
  },

  promote_from_corpus: {
    schema: {
      type: 'object',
      required: ['id', 'checkpoint'],
      properties: { id: { type: 'string' }, checkpoint: { type: 'string' }, overrides: { type: 'object' } },
    },
    apply(state, { id, checkpoint, overrides = {} }) {
      const entry = (state.corpus || []).find((c) => c.id === id);
      if (!entry) throw new Error(`not in corpus: ${id}`);
      const place = {
        id: entry.id,
        name: entry.name,
        desc: entry.desc || '',
        eta: entry.eta || entry.driveFromIC || '—',
        url: entry.url || '#',
        originalPhoto: entry.photoUrl || '',
        generatedAnim: entry.aiBackgroundUrl || 'images/abstract_glass_1774058250187.png',
        duration: entry.duration, zone: entry.zone,
        vibe: entry.vibe || [], dietary: entry.dietary || [],
        priceBand: entry.priceBand,
        ...overrides,
      };
      const corpus = state.corpus.map((c) => (c.id === id ? { ...c, promotedTo: checkpoint } : c));
      const withPlace = verbs.add_venue.apply({ ...state, corpus }, { checkpoint, place });
      return withPlace;
    },
  },

  enqueue_research: {
    schema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
        reason: { type: 'string' },
        requestedBy: { enum: ['user', 'agent'] },
      },
    },
    apply(state, { topic, reason = '', requestedBy = 'agent' }) {
      const queue = Array.isArray(state.queue) ? [...state.queue] : [];
      if (queue.some((q) => q.topic === topic)) return state;
      queue.push({ topic, reason, requestedBy, enqueuedAt: new Date().toISOString() });
      return { ...state, queue };
    },
  },
};

export function apply(state, verb, args) {
  const v = verbs[verb];
  if (!v) throw new Error(`unknown verb: ${verb}`);
  return v.apply(state, args);
}

export const READ_ONLY = new Set(['enqueue_research']);

export const VISITOR_FILTER = (verb) => READ_ONLY.has(verb);
