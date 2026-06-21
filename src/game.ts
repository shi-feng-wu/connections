// Pure game state, no DOM/Discord/network. Rules: 16 words, 4 groups of 4,
// 4 mistakes, one-away feedback, no resubmitting an identical guess.

export type Group = { level: number; category: string; members: string[] };

export type Puzzle = {
  id: number;
  date: string;
  editor: string;
  groups: Group[];
  layout: string[]; // 16 words in the official board order
  // Word → image URL for the April-Fools image-card format (e.g. 2025-04-01),
  // where each card is an SVG glyph rather than text. Absent on normal puzzles.
  // The word (a card's image_alt_text) stays the identity; this is render-only.
  images?: Record<string, string>;
};

export type SubmitResult =
  | { type: 'noop' | 'duplicate' | 'oneaway' | 'incorrect' | 'win' | 'lose' }
  | { type: 'correct'; level: number };

// Itemized end-screen score (see Game.scoreBreakdown). All point fields are
// non-negative; `penalty` is the amount mistakes subtract. `total` === Game.score.
export type ScoreBreakdown = {
  completion: number; // "Categories" — full-clear on a win, convex partial credit on a loss
  solveBonus: number; // flat reward for clearing all four (wins only)
  speed: number; // time bonus, 0–speedMax (wins only)
  penalty: number; // points lost to mistakes (wins only)
  mistakes: number; // mistake count, for the tooltip's sub-label
  total: number;
};

// small enough to broadcast to everyone in the activity.
export type Progress = {
  mistakesLeft: number;
  solvedCount: number;
  done: 'won' | 'lost' | null;
};

export const LEVELS = [
  { key: 'yellow', emoji: '🟨', color: '#f9df6d' },
  { key: 'green', emoji: '🟩', color: '#a0c35a' },
  { key: 'blue', emoji: '🟦', color: '#b0c4ef' },
  { key: 'purple', emoji: '🟪', color: '#ba81c5' },
] as const;

export const MAX_MISTAKES = 4;

// Leaderboard score. Convex in groups solved, so finishing >> partial. Losses
// score purely by groups reached: a loss always spends MAX_MISTAKES, so a
// mistake penalty would double-count. groupsSolved tops out at 2 on a loss —
// once 3 are solved the last four words are forced, so you can't miss again.
// Tuned so a perfect win (4 groups, no mistakes, instant) tops out at 500:
//   20·4² + 120 + 60 = 500. The four point values scale together; speedTargetSec
// is a time threshold (seconds), not points, so it's unscaled.
export const SCORING = {
  completionPerGroupSq: 20, // loss credit = this × groupsSolved² (max 2² = 80)
  solveBonus: 120, // flat reward for completing every group
  mistakePenalty: 30, // subtracted per mistake on a win
  speedMax: 60, // largest speed bonus on a win (only at an instant solve)
  speedTargetSec: 600, // speed bonus decays linearly from full to zero over 10 min
};

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  puzzle: Puzzle;
  board: string[];
  selected = new Set<string>();
  solved: Group[] = [];
  mistakesLeft = MAX_MISTAKES;
  status: 'playing' | 'won' | 'lost' = 'playing';
  history: number[][] = [];
  // words per guess (parallel to history); server replays these to score, since
  // the client isn't trusted.
  guesses: string[][] = [];
  startedAt = Date.now();
  durationMs: number | null = null;

  private wordLevel = new Map<string, number>();
  private guessedKeys = new Set<string>();

  constructor(puzzle: Puzzle) {
    this.puzzle = puzzle;
    for (const g of puzzle.groups) for (const m of g.members) this.wordLevel.set(m, g.level);
    this.board = puzzle.layout.slice();
  }

  // Rebuild a game by replaying an ordered guess list (each four words) from the
  // start. One shared path with two callers: the server treats its stored guesses
  // as the authoritative record (/api/guess appends, /api/score replays), and the
  // client rehydrates from that same record on reopen — so an abandoned game
  // resumes at the exact state it left (mistakes spent, groups solved, clock
  // intact) instead of resetting to a fresh board and handing out infinite tries.
  // Malformed rows and anything after the game ends are skipped, mirroring live
  // play. Pass startedAt so a replay that finishes stamps a real duration.
  static fromGuesses(puzzle: Puzzle, guesses: unknown, startedAt?: number): Game {
    const game = new Game(puzzle);
    if (startedAt != null) game.startedAt = startedAt;
    if (Array.isArray(guesses)) {
      for (const guess of guesses) {
        if (game.status !== 'playing') break;
        if (!Array.isArray(guess) || guess.length !== 4) continue;
        game.clear();
        for (const w of guess) game.toggle(String(w));
        game.submit();
      }
    }
    return game;
  }

  // difficulty level (0-3) of a word, or undefined if not on this board.
  levelOf(word: string): number | undefined {
    return this.wordLevel.get(word);
  }

  toggle(word: string): void {
    // Only words still on the board are selectable. Checking `board` (not the full
    // word set) means already-solved words can't be re-selected — so once three
    // groups are solved the forced last four are the only legal guess, making a
    // 3-group loss impossible in the model, not just in the UI. Also closes a
    // replay gap: /api/score can't be fed a guess built from off-board words.
    if (this.status !== 'playing' || !this.board.includes(word)) return;
    if (this.selected.has(word)) this.selected.delete(word);
    else if (this.selected.size < 4) this.selected.add(word);
  }

  clear(): void {
    this.selected.clear();
  }

  shuffleBoard(): void {
    this.board = shuffle(this.board);
  }

  canSubmit(): boolean {
    return this.status === 'playing' && this.selected.size === 4;
  }

  submit(): SubmitResult {
    if (!this.canSubmit()) return { type: 'noop' };

    const guess = [...this.selected];
    const key = guess.slice().sort().join('|');
    if (this.guessedKeys.has(key)) return { type: 'duplicate' };
    this.guessedKeys.add(key);

    const levels = guess.map((w) => this.wordLevel.get(w)!);
    this.history.push(levels.slice());
    this.guesses.push(guess.slice());

    if (levels.every((l) => l === levels[0])) {
      const level = levels[0];
      const group = this.puzzle.groups.find((g) => g.level === level)!;
      this.solved.push({ level, category: group.category, members: group.members });
      this.board = this.board.filter((w) => !this.selected.has(w));
      this.selected.clear();
      if (this.solved.length === 4) {
        this.finish('won');
        return { type: 'win' };
      }
      return { type: 'correct', level };
    }

    // wrong guess: keep the selection, like NYT, for tweaking.
    const counts: Record<number, number> = {};
    for (const l of levels) counts[l] = (counts[l] ?? 0) + 1;
    const oneAway = Math.max(...Object.values(counts)) === 3;
    this.mistakesLeft -= 1;

    if (this.mistakesLeft <= 0) {
      for (const g of this.puzzle.groups) {
        if (!this.solved.some((s) => s.level === g.level)) {
          this.solved.push({ level: g.level, category: g.category, members: g.members });
        }
      }
      this.board = [];
      this.selected.clear();
      this.finish('lost');
      return { type: 'lose' };
    }

    return { type: oneAway ? 'oneaway' : 'incorrect' };
  }

  private finish(status: 'won' | 'lost'): void {
    this.status = status;
    this.durationMs = Date.now() - this.startedAt;
  }

  progress(): Progress {
    return {
      mistakesLeft: this.mistakesLeft,
      solvedCount: this.solved.length,
      done: this.status === 'playing' ? null : this.status,
    };
  }

  // groups solved by deduction (correct guesses), excluding the loss back-fill.
  get groupsSolved(): number {
    return this.history.reduce((n, row) => n + (row.every((l) => l === row[0]) ? 1 : 0), 0);
  }

  // Levels solved by deduction (a correct guess is four of a kind), excluding the loss
  // back-fill (which lands in `solved`, not `history`). The roster/presence report these
  // so a finished loss doesn't paint four solved bars. Shared by the client and the
  // server-side roster replay (/api/roster).
  get deducedLevels(): number[] {
    const levels: number[] = [];
    for (const row of this.history) if (row.every((l) => l === row[0])) levels.push(row[0]);
    return levels;
  }

  // Itemized score, the single source of truth the `score` total is summed from —
  // also fed to the end-screen breakdown tooltip. `completion` is the "Categories"
  // line: full-clear credit on a win, convex partial credit on a loss. Wins add a
  // flat solveBonus + a speed term and subtract a mistake `penalty`; losses carry
  // none of those (a loss always spends MAX_MISTAKES, so a penalty would
  // double-count — see the SCORING note above). `total` clamps at 0 and equals
  // `score`.
  get scoreBreakdown(): ScoreBreakdown {
    const mistakes = MAX_MISTAKES - this.mistakesLeft;
    if (this.status !== 'won') {
      // playing → 0; lost → convex partial credit for groups reached.
      const g = this.status === 'lost' ? this.groupsSolved : 0;
      const completion = SCORING.completionPerGroupSq * g * g;
      return { completion, solveBonus: 0, speed: 0, penalty: 0, mistakes, total: completion };
    }
    const totalGroups = this.puzzle.groups.length;
    const sec = (this.durationMs ?? 0) / 1000;
    const t = SCORING.speedTargetSec;
    const speed = Math.round(SCORING.speedMax * Math.max(0, Math.min(1, (t - sec) / t)));
    const completion = SCORING.completionPerGroupSq * totalGroups * totalGroups;
    const penalty = SCORING.mistakePenalty * mistakes;
    const total = Math.max(0, completion + SCORING.solveBonus + speed - penalty);
    return { completion, solveBonus: SCORING.solveBonus, speed, penalty, mistakes, total };
  }

  // 0 while playing. Wins reward fewer mistakes + speed; losses get convex
  // partial credit for groups reached.
  get score(): number {
    return this.scoreBreakdown.total;
  }

  shareGrid(): string {
    return this.history.map((row) => row.map((l) => LEVELS[l].emoji).join('')).join('\n');
  }
}

// Score of a finished run from roster-level facts (deduced groups, mistakes left,
// duration) — the same arithmetic as Game.scoreBreakdown above, for callers that
// only have a roster row, not a Game (the Live tab shows finished players' scores).
// The roster's solvedCount is deduced groups (no loss back-fill), so it matches
// groupsSolved on both outcomes. Kept beside the class so the two move together.
export function finishedScore(
  done: 'won' | 'lost',
  groupsSolved: number,
  mistakesLeft: number,
  durationMs: number,
): number {
  const completion = SCORING.completionPerGroupSq * groupsSolved * groupsSolved;
  if (done === 'lost') return completion;
  const sec = durationMs / 1000;
  const t = SCORING.speedTargetSec;
  const speed = Math.round(SCORING.speedMax * Math.max(0, Math.min(1, (t - sec) / t)));
  const penalty = SCORING.mistakePenalty * (MAX_MISTAKES - mistakesLeft);
  return Math.max(0, completion + SCORING.solveBonus + speed - penalty);
}
