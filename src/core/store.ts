export async function writeLexiconFile(file: LexiconFile, opts: { dryRun?: boolean } = {}): Promise<void> {
  await withLexiconLock(file.path, async () => {
    const { text, readBack } = await prepareLexiconWrite(file);
    if (opts.dryRun) {
      // Validate the final document through the same pipeline that catches
      // the 200-character limit for notes/phonetic and the 80-character
      // limit for words: addTerms calls mergeTermInto which validates.
      // If any term is invalid, the error propagates up and runReview
      // returns 1 (error) without writing, as a dry-run preview should.
      await addTerms(file.lexicon.terms, { cwd: undefined, leaveUntrusted: true });
      return;
    }
    await writeFileAtomic(file.path, text, { backup: true });
    // What is on disk now is what this wrote: writeAndTrust pins exactly that.
    if (file.scope === 'project') rememberParsedBytes(file, text);
    // The next loadLexicon (the prompt hook, usually) would otherwise parse
    // the YAML it just wrote, the slowest thing a hook can do: hand it the
    // parse this write already did.
    if (file.scope === 'global') {
      const mode = await fs.stat(file.path).then((st) => st.mode & 0o777, () => undefined);
      if (mode !== undefined) await writeParseCache(file.path, text, readBack, mode);
      // Same for the compiled matcher index the hook reads next.
      await prebuildIndexCache(file.path, readBack);
    }
  });
  if (!opts.dryRun) file.exists = true;
}
export async function writeLexiconFile(file: LexiconFile, opts: { dryRun?: boolean } = {}): Promise<void> {
  await withLexiconLock(file.path, async () => {
    const { text, readBack } = await prepareLexiconWrite(file);
    if (opts.dryRun) {
      // Validate the final document through the same pipeline that catches
      // the 200-character limit for notes/phonetic: addTerms calls
      // mergeTermInto which validates each term's properties.
      await addTerms(file.lexicon.terms, { leaveUntrusted: true });
      return;
    }
    await writeFileAtomic(file.path, text, { backup: true });
    if (file.scope === 'project') rememberParsedBytes(file, text);
    if (file.scope === 'global') {
      const mode = await fs.stat(file.path).then((st) => st.mode & 0o777, () => undefined);
      if (mode !== undefined) await writeParseCache(file.path, text, readBack, mode);
      await prebuildIndexCache(file.path, readBack);
    }
  });
  if (!opts.dryRun) file.exists = true;
}
