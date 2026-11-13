// 小红书状态解析的契约测试。
//
// 这一层全是纯函数，所以用合成 fixture 覆盖「站点会怎么变脸」就够：裸 undefined、Vue 的
// `_rawValue` 包装、元组形态的卡片列表、压缩图 → 原图、登录墙 / 验证码 / 已删除的区分。
// 真实页面结构变了，先在这里补一条 fixture —— 比对着线上 HTML 猜要快得多。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replaceLooseTokens, extractXhsState, unwrap, normalizeXhsImage, pickXhsImage,
  parseXhsUrl, parseXhsNote, parseXhsUser, parseXhsFeed, detectXhsBlock, isXhsGuest,
} from '../server/xhs-state.mjs';

test('裸 undefined / NaN 只在字符串外被换成 null', () => {
  const input = '{"a":undefined,"b":"undefined 是词","c":NaN,"d":-Infinity,"e":myundefinedX}';
  assert.equal(
    replaceLooseTokens(input),
    '{"a":null,"b":"undefined 是词","c":null,"d":null,"e":myundefinedX}',
  );
});

test('字符串里的转义引号不会让状态机提前收尾', () => {
  const input = '{"a":"他说\\"undefined\\"了","b":undefined}';
  assert.equal(replaceLooseTokens(input), '{"a":"他说\\"undefined\\"了","b":null}');
});

const NOTE_HTML = `<html><script>window.__INITIAL_STATE__={"note":{"currentNoteId":"abc","noteDetailMap":{"abc":{"note":{"noteId":"abc","title":"测试笔记","desc":"正文","user":{"nickname":"作者甲","userId":"u1"},"tagList":[{"name":"unity"},{"name":"素材"}],"imageList":[{"urlDefault":"http://sns-webpic-qc.xhscdn.com/a/b!nd_dft_wlteh_webp_3","width":1080,"height":1440},{"infoList":[{"imageScene":"WB_DFT","url":"https://sns-webpic-qc.xhscdn.com/c/d!nd_x"}],"width":800,"height":600}],"video":{"media":{"stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/v.mp4"}]}}}}}}},"login":{"showLogin":false}}</script></html>`;

test('能从页面里取出并解析状态', () => {
  const state = extractXhsState(NOTE_HTML);
  assert.ok(state && typeof state === 'object');
  assert.equal(state.note.currentNoteId, 'abc');
});

test('拿不到状态时返回 null 而不是抛错', () => {
  assert.equal(extractXhsState(''), null);
  assert.equal(extractXhsState('<html>没有状态</html>'), null);
  assert.equal(extractXhsState('<script>window.__INITIAL_STATE__={坏JSON}</script>'), null);
});

test('unwrap 拆掉 Vue 的 _rawValue / _value 包装', () => {
  assert.deepEqual(unwrap({ _rawValue: [1, 2] }), [1, 2]);
  assert.deepEqual(unwrap({ _value: [3] }), [3]);
  assert.deepEqual(unwrap([4]), [4], '数组原样返回');
});

test('图片地址从压缩档升到原图', () => {
  assert.equal(
    normalizeXhsImage('http://sns-webpic-qc.xhscdn.com/x/y!nd_dft_wlteh_webp_3'),
    'https://sns-img-qc.xhscdn.com/x/y',
  );
  assert.equal(
    normalizeXhsImage('https://sns-video-bd.xhscdn.com/v.mp4'),
    'https://sns-video-bd.xhscdn.com/v.mp4',
    '视频 CDN 不该被改写',
  );
});

test('infoList 里带 WB_DFT 的那档优先', () => {
  assert.equal(
    pickXhsImage({
      urlDefault: 'https://sns-img-qc.xhscdn.com/low',
      infoList: [{ imageScene: 'WB_DFT', url: 'https://sns-img-qc.xhscdn.com/high' }],
    }),
    'https://sns-img-qc.xhscdn.com/high',
  );
});

test('链接识别覆盖笔记 / 主页 / 短链 / 裸 id', () => {
  const note = parseXhsUrl('https://www.xiaohongshu.com/explore/6a06c9360000000036001d5a?xsec_token=AA');
  assert.equal(note.type, 'note');
  assert.equal(note.noteId, '6a06c9360000000036001d5a');
  assert.equal(note.query, '?xsec_token=AA', 'xsec_token 是访问凭证，必须保留');

  assert.equal(parseXhsUrl('https://www.xiaohongshu.com/discovery/item/64e1e2f70000000012031ab2').type, 'note');
  assert.equal(parseXhsUrl('https://www.xiaohongshu.com/user/profile/5f3a2b1c000000000101d2e3').userId, '5f3a2b1c000000000101d2e3');
  assert.equal(parseXhsUrl('https://xhslink.com/o/6oKW7wkJf09').type, 'shortlink');
  assert.equal(parseXhsUrl('6a06c9360000000036001d5a').type, 'note');
  assert.equal(parseXhsUrl('随便一段话').type, 'unknown');
});

test('笔记解析带出全量图片、视频与标签', () => {
  const note = parseXhsNote(extractXhsState(NOTE_HTML), 'abc');
  assert.equal(note.title, '测试笔记');
  assert.equal(note.author, '作者甲');
  assert.deepEqual(note.tags, ['unity', '素材']);
  assert.equal(note.images.length, 2);
  assert.equal(note.images[0].url, 'https://sns-img-qc.xhscdn.com/a/b');
  assert.equal(note.images[0].width, 1080);
  assert.equal(note.images[1].url, 'https://sns-img-qc.xhscdn.com/c/d');
  assert.equal(note.videoUrl, 'https://sns-video-bd.xhscdn.com/v.mp4');
});

test('笔记解析对空状态返回 null（不伪造一张空笔记）', () => {
  assert.equal(parseXhsNote(null), null);
  assert.equal(parseXhsNote({ note: { noteDetailMap: {} } }), null);
});

test('主页解析兼容元组与对象两种卡片形态，并兼容 _rawValue', () => {
  const user = parseXhsUser({
    user: {
      userPageData: { basicInfo: { nickname: '主页作者', userId: 'uid9' } },
      notes: {
        _rawValue: [
          ['n1', { noteCard: { displayTitle: '封面1', cover: { urlDefault: 'https://sns-webpic-qc.xhscdn.com/c1!nd_x' }, xsecToken: 'tk1' } }],
          { id: 'n2', noteCard: { displayTitle: '封面2', cover: { urlDefault: 'https://sns-webpic-qc.xhscdn.com/c2' } } },
        ],
      },
    },
  });
  assert.equal(user.nickname, '主页作者');
  assert.equal(user.notes.length, 2);
  assert.equal(user.notes[0].xsecToken, 'tk1');
  assert.equal(user.notes[0].cover, 'https://sns-img-qc.xhscdn.com/c1');
});

test('搜索流解析读得到 _rawValue 里的 feeds', () => {
  const feed = parseXhsFeed({
    search: { feeds: { _rawValue: [{ id: 'f1', noteCard: { displayTitle: '搜到1', cover: { urlDefault: 'https://sns-img-qc.xhscdn.com/f1' } } }] } },
  });
  assert.equal(feed.feeds.length, 1);
  assert.equal(feed.feeds[0].noteId, 'f1');
});

test('拦截原因分得清验证码 / 登录墙 / 已删除', () => {
  assert.equal(detectXhsBlock('<html>请先登录</html>'), 'login');
  assert.equal(detectXhsBlock('<html>拖动滑块完成验证</html>'), 'captcha', '验证码优先于登录');
  assert.equal(detectXhsBlock('<html>正常</html>', { login: { showLogin: true } }), 'login');
  assert.equal(detectXhsBlock('<html>内容不存在或已被删除</html>'), 'notfound');
  assert.equal(detectXhsBlock('<html>正常</html>'), '');
});

// 小红书的匿名页面里 `login.showLogin` 一直是 false（实测），所以游客态只能看 user.loggedIn。
test('游客态靠 loggedIn / guest 判断，而不是 showLogin', () => {
  assert.equal(isXhsGuest({ login: { showLogin: false }, user: { loggedIn: false } }), true);
  assert.equal(isXhsGuest({ user: { loggedIn: false, userInfo: { guest: true } } }), true);
  assert.equal(isXhsGuest({ user: { loggedIn: true } }), false);
  assert.equal(isXhsGuest({ user: { userInfo: { _rawValue: { guest: true } } } }), true, '穿透 _rawValue');
  assert.equal(isXhsGuest(null), false);
});
