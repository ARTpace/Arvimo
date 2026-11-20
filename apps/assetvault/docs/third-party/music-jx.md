# Music platform integration

Reference: https://github.com/jiuhunwl/music_jx at a864bd067ab81033d085cf043a8cf3da7dcd0ce1.

AssetVault uses independent Node adapters for the source platforms, its public HTTP client, cookie jar, media queue and audio library. No PHP deployment, hosted third-party parser, embedded account credentials, or TLS bypass is used. NetEase and Kuwo have keyword search adapters; Qishui accepts individual track share links. Preview or denied URLs are rejected. Lyrics, album, artist and source are stored in info.json. Website APIs can change; fixture tests are not evidence of live availability.

The repository LICENSE is MIT (below); its README separately states a noncommercial restriction. This integration references platform endpoints rather than bundling the PHP/Python implementation.

MIT License

Copyright (c) 2025 JH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
