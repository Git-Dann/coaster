# Audio design

All audio is synthesised at runtime with the Web Audio API (`src/engine/audio/`). There are no audio files, so there are no licensing questions and nothing to download.

## (Not Boring) Sound Kit

The brief asks for the official (Not Boring) Sound Kit for interface feedback, subject to verified licensing. Its licence and a supplied copy could not be verified from this environment, so it is **not used**. The `AudioEngine.ui(sound)` API is the integration point: a licensed kit can replace the synthesised one-shots per `UiSound` name without touching call sites. Do not scrape sounds from their apps.

## Buses

master (gentle compressor + safety limiter) → interface, construction, coaster, environment, music. Volumes ramp with `setTargetAtTime`; mute fades the master.

## Families

- **Interface**: tap, select, toggle, slider (rate-limited), open/close, undo/redo, save, colour, material, carriage add/remove, soft error, success, circuit complete. 2–3 layers each with small pitch/gain/timing variation.
- **Construction**: timber (warm knocks, light creaks) vs steel (rounded taps, short inharmonic ring); snap, place, delete, preview tick; a soft continuous mechanical texture while supports grow.
- **Coaster**: rolling noise and filter following speed, timber rumble vs steel resonance, wind rising with speed², airtime whoosh, brake hiss, launch whoosh, lift hum, chain-dog clicks every 0.42 m of lift travel, distance attenuation and stereo pan.
- **Environment**: birds (none at night or in rain), night insects, wind (altitude and biome), river/sea water by proximity, rain, snow air. 1.5 s crossfades.
- **Music**: optional, off unless enabled. Sparse soft-piano phrases in F major pentatonic with 20–60 s silences.

Rate limiting and a 24-voice cap stop continuous drags from machine-gunning. Audio unlocks on the first user gesture; tabs going to the background suspend the context.

## Not yet done

Levels have only been checked in code and unit tests with a fake AudioContext. They have **not** been listened to on phone speakers, headphones or desktop speakers; expect a tuning pass.
