# Third-party material

## Ayumi (`vendor/ayumi.js`)

- **What:** an emulator of the AY-3-8910 and YM2149 sound chips. Every sound on
  the page is played through it.
- **Authors:** Peter Sovietov (Ayumi); JavaScript port by Alexander Kovalenko.
- **Source:** <https://github.com/alexanderk23/ayumi-js>, commit
  `3a1fb9120cc2c5ef8f538af59b46701e4c2305bb`, file `ayumi.js`.
- **Licence:** MIT. The full text is in `vendor/AYUMI_LICENSE`.
- **Changes:** none (SHA-256
  `ded3df8aa2a063bd873ec0fedf167a2f2873034467a94aaa17441feb888b1ba8`).

## CMU Pronouncing Dictionary (`vendor/cmudict.dict.gz`)

- **What:** English words to ARPAbet phonemes with stress.
- **Author:** Carnegie Mellon University.
- **Source:** <https://github.com/cmusphinx/cmudict>, `cmudict.dict` at commit
  `74790861f652b15e4ac49015a90074ad62a27690`.
- **Licence:** BSD-style. The full text is in `vendor/CMUDICT_LICENSE`.
- **Changes:** gzip compression only (SHA-256 of the uncompressed file
  `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22`).

## Data and references

- Vowel formants: G. E. Peterson and H. L. Barney, "Control methods used in a
  study of the vowels", *Journal of the Acoustical Society of America* 24,
  175–184 (1952). These are published measurements (average adult male
  values); no text or code is copied.
- "Daisy Bell" (Harry Dacre, 1892), used in an example, is in the public
  domain.
- SAM (Software Automatic Mouth, 1982) is mentioned as inspiration. No code
  from it is used.

## AS09 (`vectrex/as09/`)

- **What:** AS09 1.42, a 6809 assembler (Windows), used to build the Vectrex
  player and the editor's test cartridges.
- **Author:** Frank A. Kingswood, Kingswood Software Development Tools.
- **Terms:** copyrighted, but may be distributed freely as long as its
  manual accompanies it and no copyright messages are removed; it may not be
  sold for more than a reasonable copying fee. The manual, with these
  terms, is `vectrex/as09/as09.man.txt`.
- **Changes:** none (`as09_14.exe` SHA-256
  `cea64d992e2eedb985533e5be019c161fbcddfc9105d9d638f318a537c6f33d8`).

## SpeakJet codes

The SpeakJet allophone and control codes accepted as input
(`vectrex/vtxspeech/speakjet.py`, `js/speech.js`) follow the SpeakJet user
manual (Magnevation). Only the code numbers and mnemonics are used, as an
input format; no SpeakJet software or data is included.
