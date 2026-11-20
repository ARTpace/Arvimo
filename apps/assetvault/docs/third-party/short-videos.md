# Short video parsers

Source: https://github.com/jiuhunwl/short_videos

AssetVault adapts platform endpoint selection, media candidate ranking and Live Photo extraction ideas from this project. It uses its existing Node public HTTP client, TLS verification, account cookie jar, download queue and local library; it does not call the author's hosted parser/proxy services or require PHP/Cloudflare.

Relevant sources: Douyin Workers parser, KuaishouSpider.php, BilibiliParser.php, weibo.php, XiaohongshuParser.php. Website APIs may change; fixture tests do not establish live availability or access to restricted content.

Keyword search for Douyin, Kuaishou, Bilibili and Weibo uses source APIs when available, then the existing signed-in browser session. It reads only the first page of results (up to 60); preview and download resolve the individual post on demand. Search availability depends on the current platform session and verification requirements.

MIT License

Copyright <2025> <jiuhunwl>

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
