# W08–W14 vertical correction program status

- Updated (UTC): **2026-10-26T07:15:00Z**
- Owner: Grok in Cursor (handoff → Codex)
- Branch/HEAD: `main` / `7374e57c3f8cfef316a18d6606d5e1385b39170e`
- SampleScene SHA256: `9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9` unchanged
- W04: preserved (`codexReview:true`, Ready for Kingsley testing — not Completed)
- W08–W14 gates: remain **In progress** (`tasksComplete:false`, `automatedVerification:false`, `codexReview:false`)
- Why not Ready for Codex yet: live Unity bridge proofs for apply/capture/restore require Editor domain reload of new C# commands; contract suites prove fail-closed vertical APIs
- Contract aggregate: `npm run regress:w08-w14` **passed** (28 focused API tests + nested W13)
- W04 weapons: **43/43** preserved
- Build + dashboard gzip **242143**/256000 under target
- Next: Codex reviews vertical API/Unity command design; Kingsley domain-reloads Unity then live HertzStudioTest proofs
- Safe for takeover: yes
