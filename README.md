# @sightread/lilypond-eventdocument

Creates a typed versioned event document representing a LilyPond file.

This package does not run LilyPond itself. Compile with
[`@sightread/lilypond-wasm`](https://github.com/sightread/lilypond-wasm), passing
`event-document.ily` as `includeSettings`:

```js
import { decodeEventDocument } from '@sightread/lilypond-eventdocument'
import { LISTENER_PATH } from '@sightread/lilypond-eventdocument/node'
import { compile } from '@sightread/lilypond-wasm'
import { readFileSync } from 'node:fs'

const result = await compile(source, {
  files: { 'event-document.ily': readFileSync(LISTENER_PATH) },
  includeSettings: 'event-document.ily',
})
const document = decodeEventDocument(new TextDecoder().decode(result.files['score.events.json']))
```

