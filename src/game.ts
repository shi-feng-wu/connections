// Pure game state, no DOM/Discord/network. Rules: 16 words, 4 groups of 4,
// 4 mistakes, one-away feedback, no resubmitting an identical guess.

export type Group = { level: number; category: string; members: string[] };

export type Puzzle = {
  id: number;
  date: string;
  editor: string;
  groups: Group[];
  layout: string[]; // 16 words in the official board order
};

export type SubmitResult =
  | { type: 'noop' | 'duplicate' | 'oneaway' | 'incorrect' | 'win' | 'lose' }
  | { type: 'correct'; level: number };

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
// mistake penalty would double-count.
export const SCORING = {
  completionPerGroupSq: 100, // loss credit = this × groupsSolved²
  solveBonus: 600, // flat reward for completing every group
  mistakePenalty: 150, // subtracted per mistake on a win
  speedMax: 300, // largest speed bonus on a win
  speedTargetSec: 180, // solve in this or less for the full speed bonus; none beyond it
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

  // difficulty level (0-3) of a word, or undefined if not on this board.
  levelOf(word: string): number | undefined {
    return this.wordLevel.get(word);
  }

  toggle(word: string): void {
    if (this.status !== 'playing' || !this.wordLevel.has(word)) return;
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
      this.solved.sort((a, b) => a.level - b.level);
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

  // 0 while playing. Wins reward fewer mistakes + speed; losses get convex
  // partial credit for groups reached.
  get score(): number {
    if (this.status === 'playing') return 0;
    if (this.status === 'lost') {
      const g = this.groupsSolved;
      return SCORING.completionPerGroupSq * g * g;
    }
    const totalGroups = this.puzzle.groups.length;
    const mistakes = MAX_MISTAKES - this.mistakesLeft;
    const sec = (this.durationMs ?? 0) / 1000;
    const t = SCORING.speedTargetSec;
    const speed = Math.round(SCORING.speedMax * Math.max(0, Math.min(1, (t - sec) / t)));
    const base = SCORING.completionPerGroupSq * totalGroups * totalGroups + SCORING.solveBonus;
    return Math.max(0, base - SCORING.mistakePenalty * mistakes + speed);
  }

  shareGrid(): string {
    return this.history.map((row) => row.map((l) => LEVELS[l].emoji).join('')).join('\n');
  }
}
