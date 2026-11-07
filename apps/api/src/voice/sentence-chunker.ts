/**
 * Sentence-Chunked Streaming TTS Processor
 * Splits streaming text tokens into natural spoken sentence chunks at punctuation boundaries (. ! ? \n | ,)
 * allowing TTS synthesis and audio playback to begin before the entire response is generated.
 */

export class SentenceChunker {
  private buffer: string = '';
  private minWordCountForComma: number = 6;

  /**
   * Appends text token / fragment and returns a completed sentence chunk if boundary reached.
   */
  public push(token: string): string | null {
    this.buffer += token;

    // Check sentence terminators (. ! ? | \n)
    const terminatorMatch = this.buffer.match(/([.!?|\n]+)\s+/);
    if (terminatorMatch && terminatorMatch.index !== undefined) {
      const cutIndex = terminatorMatch.index + terminatorMatch[1].length;
      const sentence = this.buffer.slice(0, cutIndex).trim();
      this.buffer = this.buffer.slice(cutIndex).trimStart();
      if (sentence.length > 0) {
        return sentence;
      }
    }

    // Check comma or pause delimiter if buffer has enough words for spoken cadence
    const words = this.buffer.split(/\s+/).filter(Boolean);
    if (words.length >= this.minWordCountForComma) {
      const commaMatch = this.buffer.match(/([,;])\s+/);
      if (commaMatch && commaMatch.index !== undefined) {
        const cutIndex = commaMatch.index + commaMatch[1].length;
        const sentence = this.buffer.slice(0, cutIndex).trim();
        this.buffer = this.buffer.slice(cutIndex).trimStart();
        if (sentence.length > 0) {
          return sentence;
        }
      }
    }

    return null;
  }

  /**
   * Flushes remaining text in buffer upon stream completion.
   */
  public flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining.length > 0 ? remaining : null;
  }

  public reset(): void {
    this.buffer = '';
  }
}

/**
 * Splits a full text reply into natural spoken sentence chunks.
 */
export function splitIntoSentences(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  // Match sentences ending with . ! ? \n | or clauses with commas after multiple words
  const sentences: string[] = [];
  const rawSegments = text.split(/(?<=[.!?|\n])\s+/);

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (trimmed.length > 0) {
      sentences.push(trimmed);
    }
  }

  return sentences.length > 0 ? sentences : [text.trim()];
}
