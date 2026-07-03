import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getSource } from '../datasource';
import { logger } from '../logger';

// A position in the data source. The deck is a shuffled list of these — one per
// eligible card — so every card has an equal chance regardless of how many peers
// its section has.
type CardLocation = {
  chapterKey: string;
  sectionKey: string;
  groupIndex: number;
  cardIndex: number;
};

// The card currently on screen, plus the per-view choices (in which order to
// page the phrases, which side first) that are re-rolled every time a card is
// shown. `phraseOrder` is a shuffled permutation of the card's phrase indices;
// `phrasePos` is the cursor into it that the ◀ ▶ pager moves.
type HistoryEntry = CardLocation & {
  phraseOrder: number[];
  phrasePos: number;
  showQuestionFirst: boolean;
};

type State = {
  deck: CardLocation[];
  cursor: number;
  current: HistoryEntry;
  step: number;
  enabledSections: string[];
};

type Action =
  | { type: 'ADVANCE'; maxStep: number; deck: CardLocation[]; cursor: number; current: HistoryEntry }
  | { type: 'PREVIOUS'; current: HistoryEntry }
  | { type: 'RESTART'; deck: CardLocation[]; current: HistoryEntry }
  | { type: 'SET_ENABLED_SECTIONS'; enabledSections: string[]; deck: CardLocation[]; current: HistoryEntry }
  | { type: 'NEXT_PHRASE' }
  | { type: 'PREV_PHRASE' };

// Layer 1 — pure. No closure access. Exported for direct testability.
// Impure choices (shuffled decks, re-rolled entries) are computed by the action
// creators and handed in, so transitions here stay deterministic.
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADVANCE': {
      // Each card is revealed in steps; only once the steps are exhausted do we
      // move the cursor to the next card in the deck.
      if (state.step < action.maxStep) return { ...state, step: state.step + 1 };
      return { ...state, deck: action.deck, cursor: action.cursor, current: action.current, step: 0 };
    }
    case 'PREVIOUS': {
      if (state.cursor === 0) return state;
      return { ...state, cursor: state.cursor - 1, current: action.current, step: 0 };
    }
    case 'RESTART':
      return { ...state, deck: action.deck, cursor: 0, current: action.current, step: 0 };
    case 'SET_ENABLED_SECTIONS':
      return {
        ...state,
        enabledSections: action.enabledSections,
        deck: action.deck,
        cursor: 0,
        current: action.current,
        step: 0,
      };
    case 'NEXT_PHRASE': {
      // Paging stops at the ends — no wrap; the UI disables the arrow here.
      if (state.current.phrasePos >= state.current.phraseOrder.length - 1) return state;
      return { ...state, current: { ...state.current, phrasePos: state.current.phrasePos + 1 } };
    }
    case 'PREV_PHRASE': {
      if (state.current.phrasePos <= 0) return state;
      return { ...state, current: { ...state.current, phrasePos: state.current.phrasePos - 1 } };
    }
  }
};

// Layer 2 — impurity quarantined here.
const allSectionKeys = (): string[] =>
  Object.values(getSource().cards).flatMap(chapter => Object.keys(chapter));

// Flatten every card in the enabled sections into a flat list of locations.
// Enumerating per-card (rather than picking section → group → card at random) is
// what gives each card uniform probability.
const eligibleCards = (enabledSections: string[]): CardLocation[] => {
  const enabled = new Set(enabledSections);
  const out: CardLocation[] = [];
  for (const [chapterKey, chapter] of Object.entries(getSource().cards)) {
    for (const [sectionKey, groups] of Object.entries(chapter)) {
      if (!enabled.has(sectionKey)) continue;
      groups.forEach((group, groupIndex) => {
        group.cards.forEach((_card, cardIndex) => {
          out.push({ chapterKey, sectionKey, groupIndex, cardIndex });
        });
      });
    }
  }
  return out;
};

// Fisher–Yates: unbiased in-place shuffle on a copy.
const shuffle = <T>(items: readonly T[]): T[] => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const buildDeck = (enabledSections: string[]): CardLocation[] => shuffle(eligibleCards(enabledSections));

const groupAt = (loc: CardLocation) =>
  getSource().cards[loc.chapterKey]![loc.sectionKey]![loc.groupIndex]!;

// Turn a deck location into a displayable entry, re-rolling the phrase paging
// order and the question/answer orientation for this viewing. Every card is
// guaranteed at least one phrase by the Card type, so `phraseOrder` is non-empty
// and `phrasePos` 0 is always valid. A section may pin the orientation via
// `showQuestionFirstAlways` (e.g. pronunciation drills that only read correctly
// question-first); otherwise the side is chosen at random.
const rollEntry = (loc: CardLocation): HistoryEntry => {
  const group = groupAt(loc);
  const card = group.cards[loc.cardIndex]!;
  const phraseOrder = shuffle([...card.phrases.keys()]);
  const showQuestionFirst = group.showQuestionFirstAlways === true || Math.random() < 0.5;
  return { ...loc, phraseOrder, phrasePos: 0, showQuestionFirst };
};

// We persist the *disabled* sections, not the enabled ones, so that content
// added in a later deploy is enabled by default: a section absent from storage
// (because it didn't exist when the user last saved) is treated as on, not off.
const LS_KEY = 'flashcards.disabledSections';

const loadEnabledSections = (): string[] => {
  const all = allSectionKeys();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return all;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return all;
    // Only sections the user explicitly turned off (and that still exist) are
    // filtered out; everything else — including brand-new sections — stays on.
    const disabled = new Set(parsed.filter((k): k is string => typeof k === 'string'));
    return all.filter(k => !disabled.has(k));
  } catch (error) {
    logger.warn('failed to load disabled sections from localStorage; falling back to all sections', error);
    return all;
  }
};

const saveEnabledSections = (keys: string[]): void => {
  try {
    // Store the complement — the sections that are off — against the current
    // catalog, so stale keys for deleted sections don't accumulate.
    const enabled = new Set(keys);
    const disabled = allSectionKeys().filter(k => !enabled.has(k));
    localStorage.setItem(LS_KEY, JSON.stringify(disabled));
  } catch (error) {
    // localStorage unavailable (private mode, quota, etc.) — non-fatal
    logger.warn('failed to persist disabled sections to localStorage', error);
  }
};

// Layer 3 — store. Single mutation site is `dispatch`; side effects (localStorage, randomness)
// live in action creators.
export const useFlashcardsStore = defineStore('flashcards', () => {
  const initialEnabled = loadEnabledSections();
  const initialDeck = buildDeck(initialEnabled);
  logger.info(`initializing flashcards store with ${initialDeck.length} eligible cards across ${initialEnabled.length} enabled sections`);

  // Always seed `current` with a real card so the getters render even when no
  // sections are enabled (the UI hides it via isEmpty).
  const initialLocation = initialDeck[0] ?? eligibleCards(allSectionKeys())[0]!;
  const state = ref<State>({
    deck: initialDeck,
    cursor: 0,
    current: rollEntry(initialLocation),
    step: 0,
    enabledSections: initialEnabled,
  });

  const dispatch = (action: Action) => {
    state.value = reducer(state.value, action);
  };

  const currentGroup = computed(() => getSource().cards[state.value.current.chapterKey]![state.value.current.sectionKey]![state.value.current.groupIndex]!);
  const currentCard = computed(() => currentGroup.value.cards[state.value.current.cardIndex]!);
  const currentPhrase = computed(
    () => currentCard.value.phrases[state.value.current.phraseOrder[state.value.current.phrasePos]!]!,
  );
  const canPreviousPhrase = computed(() => state.value.current.phrasePos > 0);
  const canNextPhrase = computed(
    () => state.value.current.phrasePos < state.value.current.phraseOrder.length - 1,
  );
  const currentChapter = computed(() => state.value.current.chapterKey);
  const currentSection = computed(() => state.value.current.sectionKey);
  const currentSubTitle = computed(() => currentGroup.value.subTitle);
  const canGoPrevious = computed(() => state.value.cursor > 0);
  const allChapters = computed(() => Object.keys(getSource().cards));
  const allSections = computed(() => allSectionKeys());
  const isEmpty = computed(() => state.value.enabledSections.length === 0);
  const canRestart = computed(() => state.value.step > 0 || state.value.cursor > 0);

  const advance = () => {
    const s = state.value;
    if (s.deck.length === 0) return;
    const maxStep = 1;
    // Only the "move to the next card" branch needs a fresh entry (and possibly a
    // reshuffle); during a step increment the reducer ignores these, so skip the
    // work — mirrors the reducer's own step guard.
    const moving = s.step >= maxStep;
    const nextCursor = s.cursor + 1;
    const wrap = nextCursor >= s.deck.length;
    const deck = moving && wrap ? buildDeck(s.enabledSections) : s.deck;
    const cursor = wrap ? 0 : nextCursor;
    const current = moving ? rollEntry(deck[cursor]!) : s.current;
    dispatch({ type: 'ADVANCE', maxStep, deck, cursor, current });
  };

  const previous = () => {
    const s = state.value;
    if (s.cursor === 0) return;
    dispatch({ type: 'PREVIOUS', current: rollEntry(s.deck[s.cursor - 1]!) });
  };

  const restart = () => {
    const deck = buildDeck(state.value.enabledSections);
    const current = deck.length > 0 ? rollEntry(deck[0]!) : state.value.current;
    dispatch({ type: 'RESTART', deck, current });
  };

  const setEnabledSections = (keys: string[]) => {
    const deck = buildDeck(keys);
    const current = deck.length > 0 ? rollEntry(deck[0]!) : state.value.current;
    dispatch({ type: 'SET_ENABLED_SECTIONS', enabledSections: keys, deck, current });
    saveEnabledSections(keys);
  };

  const nextPhrase = () => dispatch({ type: 'NEXT_PHRASE' });
  const previousPhrase = () => dispatch({ type: 'PREV_PHRASE' });

  return {
    state,
    currentCard,
    currentPhrase,
    currentChapter,
    currentSection,
    currentSubTitle,
    canGoPrevious,
    canRestart,
    canPreviousPhrase,
    canNextPhrase,
    allChapters,
    allSections,
    isEmpty,
    advance,
    previous,
    restart,
    setEnabledSections,
    nextPhrase,
    previousPhrase,
  };
});
