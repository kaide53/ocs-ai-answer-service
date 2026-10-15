'use strict';
/**
 * OCS 答案→选项匹配算法移植版的单元测试。
 *
 * 断言中的"期望值"全部取自真实的 OCS 源码行为（用 esbuild 编译
 * /tmp/ocsjs/packages/core 下的原始 TS 后运行比对得出），而不是凭直觉书写。
 * 移植版与原始实现在 86,492 组随机/定向差分用例上完全一致。
 *
 * 仅使用 Node 内置的 node:test + node:assert/strict。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/ocs/matcher.js');

/* ==========================================================================
 * 导出契约
 * ==========================================================================*/
describe('模块导出契约', () => {
	test('导出了任务要求的全部函数与常量', () => {
		const required = [
			'splitAnswer',
			'isPlainAnswer',
			'resolvePlainAnswer',
			'isProgramAnswer',
			'removeRedundant',
			'normalizeString',
			'clearString',
			'answerNormalizedMatch',
			'answerSimilar',
			'answerSimilarWithGap',
			'disambiguateSimilarOptions',
			'resolveSingle',
			'resolveMultiple',
			'resolveJudgement',
			'resolveCompletion',
			'isJudgementOptions',
			'defaultWorkTypeResolver',
			'CORRECT_WORDS',
			'INCORRECT_WORDS'
		];
		for (const name of required) {
			assert.ok(name in m, `缺少导出：${name}`);
		}
		assert.equal(typeof m.splitAnswer, 'function');
		assert.ok(Array.isArray(m.CORRECT_WORDS));
		assert.ok(Array.isArray(m.INCORRECT_WORDS));
	});
});

/* ==========================================================================
 * string-similarity@4.0.4 复刻
 * ==========================================================================*/
describe('string-similarity 复刻（Dice 系数 / bigram）', () => {
	test('完全相同返回 1（包括两个空串，这是它的边界行为）', () => {
		assert.equal(m.compareTwoStrings('abc', 'abc'), 1);
		assert.equal(m.compareTwoStrings('', ''), 1);
		assert.equal(m.compareTwoStrings('巴黎', '巴黎'), 1);
	});

	test('比较前先删除所有空白字符', () => {
		assert.equal(m.compareTwoStrings('a b c', 'abc'), 1);
		assert.equal(m.compareTwoStrings('a\nb\tc', 'abc'), 1);
	});

	test('任一字符串长度小于 2 时返回 0（无法构造 bigram）', () => {
		assert.equal(m.compareTwoStrings('a', 'abc'), 0);
		assert.equal(m.compareTwoStrings('abc', 'a'), 0);
		assert.equal(m.compareTwoStrings('a', 'b'), 0);
		assert.equal(m.compareTwoStrings('', 'abc'), 0);
	});

	test('没有公共 bigram 返回 0', () => {
		assert.equal(m.compareTwoStrings('abc', 'xyz'), 0);
	});

	test('Dice 公式：2*|A∩B| / (|A|+|B|)，分母等于 len(a)+len(b)-2', () => {
		// bigram(abc) = {ab, bc}，bigram(abd) = {ab, bd} → 交集 1 → 2*1/(3+3-2) = 0.5
		assert.equal(m.compareTwoStrings('abc', 'abd'), 0.5);
		// 容量不同：abcdwxyz(7 个 bigram) vs abcd(3 个) → 交集 3 → 6/(8+4-2) = 0.6
		assert.equal(m.compareTwoStrings('abcdwxyz', 'abcd'), 0.6);
		// 中文按字符切窗，"计算机网络" 的 bigram 是 计算/算机/机网/网络
		assert.equal(m.compareTwoStrings('计算机网络原理', '计算机网络'), 0.8);
	});

	test('bigram 是多重集合：重复 bigram 需要按最小重数计入交集', () => {
		// bigram(aaa) = {aa, aa}（2 个），bigram(aa) = {aa} → 交集 1 → 2/(3+2-2) = 0.666...
		assert.equal(m.compareTwoStrings('aaa', 'aa'), 2 / 3);
	});

	test('findBestMatch 返回 ratings / bestMatch / bestMatchIndex', () => {
		const r = m.findBestMatch('abc', ['xyz', 'abc', 'abd']);
		assert.equal(r.ratings.length, 3);
		assert.deepEqual(r.ratings[0], { target: 'xyz', rating: 0 });
		assert.deepEqual(r.bestMatch, { target: 'abc', rating: 1 });
		assert.equal(r.bestMatchIndex, 1);
	});

	test('并列最高分时取下标最小的选项（比较用严格 >）', () => {
		const r = m.findBestMatch('abc', ['abc', 'abc']);
		assert.equal(r.bestMatchIndex, 0);
		assert.equal(r.bestMatch.rating, 1);
	});

	test('参数非法时抛错（空数组 / 非字符串）', () => {
		assert.throws(() => m.findBestMatch('a', []), /Bad arguments/);
		assert.throws(() => m.findBestMatch('a', [1]), /Bad arguments/);
		assert.throws(() => m.findBestMatch(1, ['a']), /Bad arguments/);
	});
});

/* ==========================================================================
 * splitAnswer
 * ==========================================================================*/
describe('splitAnswer —— 答案分割', () => {
	test('默认分隔符逐个生效：=== / # / --- / ### / | / ; / ；', () => {
		assert.deepEqual(m.splitAnswer('A===B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A#B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A---B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A###B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A|B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A;B'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A；B'), ['A', 'B']);
	});

	test('只按第一个能拆出多段的分隔符拆分，各段 trim 并去空', () => {
		assert.deepEqual(m.splitAnswer('  A  ===  B  '), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A===B===C'), ['A', 'B', 'C']);
		assert.deepEqual(m.splitAnswer('A##B'), ['A', 'B']); // 由 '#' 拆分，空段被过滤
	});

	test('输入是 JSON 数组字符串时返回解析后的数组', () => {
		assert.deepEqual(m.splitAnswer('["A","B"]'), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('[1,2,3]'), ['1', '2', '3']);
		assert.deepEqual(m.splitAnswer('["A","", "B"]'), ['A', 'B']); // 去空段
		assert.deepEqual(m.splitAnswer('[]'), []);
		assert.deepEqual(m.splitAnswer('[[ "A" ],[ "B" ]]'), ['A', 'B']); // 内层数组被 String() 化
	});

	test('空字符串与纯空白返回空数组', () => {
		assert.deepEqual(m.splitAnswer(''), []);
		assert.deepEqual(m.splitAnswer('   '), []);
		assert.deepEqual(m.splitAnswer('\n\t '), []);
	});

	test('不含分隔符时返回单元素数组', () => {
		assert.deepEqual(m.splitAnswer('单个答案'), ['单个答案']);
		assert.deepEqual(m.splitAnswer('  巴黎  '), ['巴黎']);
	});

	test('反直觉：合法 JSON 但不是数组时完全不拆分（连分隔符也不试）', () => {
		// JSON.parse 成功但结果不是 Array → 既不 return 也不进 catch → 落到 return [answer]
		assert.deepEqual(m.splitAnswer('123'), ['123']);
		assert.deepEqual(m.splitAnswer('true'), ['true']);
		assert.deepEqual(m.splitAnswer('null'), ['null']);
		assert.deepEqual(m.splitAnswer('{"a":1}'), ['{"a":1}']);
		// 带引号的 JSON 字符串同样不拆，分隔符原样留在答案里
		assert.deepEqual(m.splitAnswer('"A#B"'), ['"A#B"']);
	});

	test('JSON 解析失败时走分隔符分支', () => {
		assert.deepEqual(m.splitAnswer('["A","B"'), ['["A","B"']); // 非法 JSON，且无分隔符
	});

	test('程序代码中的 ; | ； 不当作分隔符', () => {
		assert.deepEqual(m.splitAnswer('printf("hello"); printf("world")'), ['printf("hello"); printf("world")']);
		assert.deepEqual(m.splitAnswer('void main() { int a; int b; a = b | 1; }'), ['void main() { int a; int b; a = b | 1; }']);
		assert.deepEqual(m.splitAnswer('console.log("a")；console.log("b")'), ['console.log("a")；console.log("b")']);
	});

	test('非程序文本里的 ; | ； 仍然是分隔符', () => {
		assert.equal(m.isProgramAnswer('A;B'), false);
		assert.deepEqual(m.splitAnswer('A;B'), ['A', 'B']);
		assert.equal(m.isProgramAnswer('对;错'), false);
		assert.deepEqual(m.splitAnswer('对;错'), ['对', '错']);
	});

	test('反直觉：程序代码里的 # 仍然会被当分隔符（isProgramAnswer 只取消 ; | ；）', () => {
		const code = '#include <stdio.h>\nint main() { printf("hi"); return 0; }';
		// 首段为空被过滤，'#' 被吃掉
		assert.deepEqual(m.splitAnswer(code), ['include <stdio.h>\nint main() { printf("hi"); return 0; }']);
	});

	test('自定义分隔符：空数组回退默认值，过滤后为空则退化为不拆分', () => {
		assert.deepEqual(m.splitAnswer('A#B', []), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A#B', ['#']), ['A', 'B']);
		assert.deepEqual(m.splitAnswer('A#B', ['====']), ['A#B']);
		assert.deepEqual(m.splitAnswer('A#B', ['', '  ']), ['A#B']);
		assert.deepEqual(m.splitAnswer('A@B', ['@']), ['A', 'B']);
	});
});

describe('isProgramAnswer —— 程序题特征判定', () => {
	test('强特征命中即为程序题', () => {
		assert.equal(m.isProgramAnswer('printf("hello"); printf("world")'), true);
		assert.equal(m.isProgramAnswer('void main() { int a; int b; a = b | 1; }'), true);
		assert.equal(m.isProgramAnswer('console.log("a")；console.log("b")'), true);
		assert.equal(m.isProgramAnswer('class A { int x; }'), true);
	});

	test('不含 ; | ； 时直接判定为非程序（避免误判）', () => {
		assert.equal(m.isProgramAnswer('int main() { }'), false);
		assert.equal(m.isProgramAnswer('巴黎'), false);
		assert.equal(m.isProgramAnswer(''), false);
	});

	test('弱特征累计不足 2 分时不算程序题', () => {
		// 只有语句终止符 ; 计 1 分
		assert.equal(m.isProgramAnswer('print(x);'), false);
		// for( + int i + 花括号 + ';' → 4 分
		assert.equal(m.isProgramAnswer('for (int i = 0; i < 10; i++) { }'), true);
		// if( + 花括号 + ';' → 3 分
		assert.equal(m.isProgramAnswer('if (a > 1) { b = a | 2; }'), true);
	});

	test('纯字母/多选答案不会被误判为程序题', () => {
		assert.equal(m.isProgramAnswer('A;B'), false);
		assert.equal(m.isProgramAnswer('A#B#C'), false);
	});
});

/* ==========================================================================
 * isPlainAnswer / resolvePlainAnswer
 * ==========================================================================*/
describe('isPlainAnswer —— 纯字母答案判定', () => {
	test('单字母与递增字母串合法', () => {
		assert.equal(m.isPlainAnswer('A'), true);
		assert.equal(m.isPlainAnswer('AB'), true);
		assert.equal(m.isPlainAnswer('ABC'), true);
		assert.equal(m.isPlainAnswer('ABCDEFGH'), true); // 恰好 8 位
	});

	test('必须严格递增：BA 不合法', () => {
		assert.equal(m.isPlainAnswer('BA'), false);
		assert.equal(m.isPlainAnswer('CBA'), false);
	});

	test('不能有重复字符：AA 不合法', () => {
		assert.equal(m.isPlainAnswer('AA'), false);
		assert.equal(m.isPlainAnswer('ABCA'), false);
	});

	test('长度大于 8 不合法', () => {
		assert.equal(m.isPlainAnswer('ABCDEFGHI'), false);
	});

	test('必须含大写字母，且字符码必须递增', () => {
		assert.equal(m.isPlainAnswer('a'), false);
		assert.equal(m.isPlainAnswer(''), false);
		assert.equal(m.isPlainAnswer('A1'), false); // '1'(49) < 'A'(65)，递减
		assert.equal(m.isPlainAnswer('1A'), true); // 反直觉：下限是 0 不是 'A'，'1'(49) ≥ 0 后 'A'(65) 递增即可
	});

	test('反直觉：只校验 charCode 递增，不校验是否为字母，所以 "A[" 也算纯字母答案', () => {
		assert.equal(m.isPlainAnswer('A['), true); // '[' 是 91，大于 'A' 的 65
		assert.equal(m.isPlainAnswer('A_'), true); // '_' 是 95
	});
});

describe('resolvePlainAnswer —— 带分隔符的纯字母答案', () => {
	test('逗号、顿号、点号、空格、# 会被剔除后判定', () => {
		assert.equal(m.resolvePlainAnswer('A,B'), 'AB');
		assert.equal(m.resolvePlainAnswer('A、B'), 'AB');
		assert.equal(m.resolvePlainAnswer('A B'), 'AB');
		assert.equal(m.resolvePlainAnswer('A.B'), 'AB');
		assert.equal(m.resolvePlainAnswer('A#B#C'), 'ABC');
		assert.equal(m.resolvePlainAnswer('A, B'), 'AB');
	});

	test('不合法时返回 undefined（不是 null、不是空串）', () => {
		assert.equal(m.resolvePlainAnswer('BA'), undefined);
		assert.equal(m.resolvePlainAnswer('AA'), undefined);
		assert.equal(m.resolvePlainAnswer('巴黎'), undefined);
		assert.equal(m.resolvePlainAnswer(''), undefined);
	});
});

/* ==========================================================================
 * removeRedundant / clearString / normalizeString
 * ==========================================================================*/
describe('removeRedundant —— 剥离选项前缀标签', () => {
	test('字母 + 分隔符 + 内容 的标签被剥离', () => {
		assert.equal(m.removeRedundant('A. 白崇禧'), '白崇禧');
		assert.equal(m.removeRedundant('B) 巴黎'), '巴黎');
		assert.equal(m.removeRedundant('D:伦敦'), '伦敦');
		assert.equal(m.removeRedundant('C-李宗仁'), '李宗仁');
	});

	test('字母直接紧跟中文的标签被剥离', () => {
		assert.equal(m.removeRedundant('A选项'), '选项');
		assert.equal(m.removeRedundant('C男女平等'), '男女平等');
	});

	test('字母串开头的英文术语不能被误剥离', () => {
		assert.equal(m.removeRedundant('TCP协议'), 'TCP协议');
		assert.equal(m.removeRedundant('CPU'), 'CPU');
		assert.equal(m.removeRedundant('A'), 'A');
		assert.equal(m.removeRedundant('AB'), 'AB');
	});

	test('反直觉：A、白崇禧 的前缀剥不掉，得到 "、白崇禧"（顿号 U+3001 落在 [\\u2E80-\\u9FFF] 内）', () => {
		// 任务书期望 'A、白崇禧' → '白崇禧'，但真实 OCS 源码并非如此：
		// 规则1 要求字母后紧跟"非中文非字母数字"的分隔符，而 '、'(U+3001) 落在 [\u2E80-\u9FFF] 里，
		// 于是规则1 不生效，规则2 把 '、白崇禧' 整体当作"紧跟在字母后的中文内容"返回。
		// 结论由编译后的真实 OCS 源码验证。
		assert.equal(m.removeRedundant('A、白崇禧'), '、白崇禧');
		assert.equal(m.removeRedundant('C、李宗仁'), '、李宗仁');
		// 同属 [\u2E80-\u9FFF] 的还有 。【】《》 等
		assert.equal(m.removeRedundant('A。白崇禧'), '。白崇禧');
		assert.equal(m.removeRedundant('A】白崇禧'), '】白崇禧');
		// 而 ASCII 与"超出 CJK 区间"的全角标点（U+FF00 段）能被规则1 正确剥离
		assert.equal(m.removeRedundant('A，白崇禧'), '白崇禧'); // '，' U+FF0C 不在 [\u2E80-\u9FFF] 内
		assert.equal(m.removeRedundant('A：白崇禧'), '白崇禧');
		assert.equal(m.removeRedundant('A）白崇禧'), '白崇禧');
		// 实际影响很小：归一化匹配前还会走 normalizeString，顿号会被去掉
		assert.equal(m.normalizeString(m.removeRedundant('A、白崇禧')), '白崇禧');
		assert.deepEqual(m.answerNormalizedMatch(['A、白崇禧'], ['A、白崇禧', 'B、李宗仁']), ['A、白崇禧']);
	});

	test('非字符串输入返回空串', () => {
		assert.equal(m.removeRedundant(undefined), '');
		assert.equal(m.removeRedundant(null), '');
		assert.equal(m.removeRedundant(''), '');
	});
});

describe('clearString / normalizeString', () => {
	test('clearString：去首尾空白、转小写、只保留英文数字中文', () => {
		assert.equal(m.clearString('  AbC  '), 'abc');
		assert.equal(m.clearString('A. 巴黎!'), 'a巴黎');
		assert.equal(m.clearString('（巴黎）'), '巴黎');
	});

	test('反直觉：exclude 参数是"保留白名单"而非"要删除的字符"', () => {
		assert.equal(m.clearString('①②③A'), '①②③a'); // ①②③④⑤⑥⑦⑧⑨ 永远被保留
		assert.equal(m.clearString('√对×', '√', '×'), '√对×');
		assert.equal(m.clearString('√对×'), '对'); // 不传 exclude 时 √ × 被删除
	});

	test('clearString 不做全角转半角，全角字母会被直接删掉', () => {
		assert.equal(m.clearString('Ａ'), ''); // 先小写变成 'ａ'（U+FF41），不在允许范围
		assert.equal(m.clearString('ＡＢＣ'), '');
	});

	test('normalizeString：去中英标点与空白 + 全角转半角 + clearString', () => {
		assert.equal(m.normalizeString('（巴黎）'), '巴黎');
		assert.equal(m.normalizeString('A. 巴黎'), 'a巴黎');
		assert.equal(m.normalizeString('ＡＢＣ'), 'abc'); // 全角→半角在 clearString 之前
		assert.equal(m.normalizeString('Ａ. 巴黎'), 'a巴黎');
		assert.equal(m.normalizeString('100％'), '100'); // ％→% 后被 clearString 删除
		assert.equal(m.normalizeString('巴黎 ， 伦敦'), '巴黎伦敦');
	});
});

/* ==========================================================================
 * answerNormalizedMatch / answerSimilar / answerSimilarWithGap
 * ==========================================================================*/
describe('answerNormalizedMatch —— 归一化精确匹配（单向）', () => {
	test('归一化相等时命中，返回原始选项文本', () => {
		assert.deepEqual(m.answerNormalizedMatch(['巴黎'], ['巴黎', '伦敦']), ['巴黎']);
		assert.deepEqual(m.answerNormalizedMatch(['（巴黎）'], ['巴黎', '伦敦']), ['巴黎']);
	});

	test('答案为选项的超串（答案⊇选项）时按包含命中', () => {
		assert.deepEqual(m.answerNormalizedMatch(['巴黎是法国的首都'], ['巴黎', '伦敦']), ['巴黎']);
	});

	test('严格单向：选项是答案的超串不命中（避免"TCP"误选"TCP/IP协议"）', () => {
		assert.deepEqual(m.answerNormalizedMatch(['巴黎'], ['巴黎是法国的首都']), []);
		assert.deepEqual(m.answerNormalizedMatch(['TCP'], ['TCP/IP协议']), []);
	});

	test('精确命中（level 2）排在包含命中（level 1）之前', () => {
		assert.deepEqual(m.answerNormalizedMatch(['巴黎是法国的首都'], ['巴黎', '巴黎是法国的首都']), [
			'巴黎是法国的首都',
			'巴黎'
		]);
	});

	test('答案列表为空时返回空数组', () => {
		assert.deepEqual(m.answerNormalizedMatch([], ['巴黎']), []);
	});
});

describe('answerSimilar / answerSimilarWithGap', () => {
	test('每个选项返回它在答案列表中的最佳匹配 { target, rating }', () => {
		assert.deepEqual(m.answerSimilar(['巴黎'], ['巴黎', '伦敦']), [
			{ target: '巴黎', rating: 1 },
			{ target: '巴黎', rating: 0 }
		]);
	});

	test('反直觉：rating 为 0 时 target 仍是最佳匹配答案（而非空串）', () => {
		assert.deepEqual(m.answerSimilar(['巴黎'], ['伦敦']), [{ target: '巴黎', rating: 0 }]);
	});

	test('选项归一化后为空串时返回 { rating: 0, target: "" }', () => {
		assert.deepEqual(m.answerSimilar(['巴黎'], ['', '巴黎']), [
			{ rating: 0, target: '' },
			{ target: '巴黎', rating: 1 }
		]);
	});

	test('答案列表为空时全部为 0', () => {
		assert.deepEqual(m.answerSimilar([], ['巴黎']), [{ rating: 0, target: '' }]);
		assert.deepEqual(m.answerSimilarWithGap([], ['巴黎']), [{ rating: 0, target: '', gap: 0 }]);
	});

	test('answerSimilarWithGap：gap = 最高分 - 次高分，仅最高分选项有值', () => {
		assert.deepEqual(m.answerSimilarWithGap(['巴黎'], ['巴黎', '巴黎是法国的首都', '伦敦']), [
			{ target: '巴黎', rating: 1, gap: 0.75 },
			{ target: '巴黎', rating: 0.25, gap: 0 },
			{ target: '巴黎', rating: 0, gap: 0 }
		]);
	});

	test('answerSimilarWithGap：并列最高分时都有相同的 gap', () => {
		assert.deepEqual(m.answerSimilarWithGap(['巴黎', '伦敦'], ['巴黎', '伦敦', '柏林']), [
			{ target: '巴黎', rating: 1, gap: 1 },
			{ target: '伦敦', rating: 1, gap: 1 },
			{ target: '巴黎', rating: 0, gap: 0 }
		]);
	});

	test('answerSimilarWithGap：只有一个选项时 gap 等于它自己的分数', () => {
		assert.deepEqual(m.answerSimilarWithGap(['巴黎'], ['巴黎']), [{ target: '巴黎', rating: 1, gap: 1 }]);
	});
});

/* ==========================================================================
 * disambiguateSimilarOptions
 * ==========================================================================*/
describe('disambiguateSimilarOptions —— 相似选项消歧', () => {
	test('一字之差的选项只保留与答案匹配度更高的那个', () => {
		assert.deepEqual(m.disambiguateSimilarOptions(['计算机网络', '计算机网络原理'], [1, 0.8]), ['计算机网络']);
		assert.deepEqual(m.disambiguateSimilarOptions(['计算机网络原理', '计算机网络'], [0.8, 1]), ['计算机网络']);
	});

	test('选项文本不相似时全部保留', () => {
		assert.deepEqual(m.disambiguateSimilarOptions(['巴黎', '伦敦', '柏林'], [1, 1, 1]), ['巴黎', '伦敦', '柏林']);
	});

	test('分数相同时保留靠前的选项', () => {
		assert.deepEqual(m.disambiguateSimilarOptions(['计算机网络', '计算机网络原理'], [0.8, 0.8]), ['计算机网络']);
	});

	test('选项数 <= 1 时原样返回', () => {
		const one = ['巴黎'];
		assert.equal(m.disambiguateSimilarOptions(one, [0.5]), one);
		assert.deepEqual(m.disambiguateSimilarOptions([], []), []);
	});
});

/* ==========================================================================
 * resolveSingle
 * ==========================================================================*/
describe('resolveSingle —— 单选题匹配', () => {
	test('阶段1：答案给完整选项文本时精确命中', () => {
		assert.deepEqual(m.resolveSingle(['巴黎'], ['伦敦', '巴黎']), { finish: true, option: '巴黎' });
	});

	test('阶段1：带选项标签的答案能命中带标签的选项', () => {
		assert.deepEqual(m.resolveSingle(['巴黎'], ['A. 巴黎', 'B. 伦敦']), { finish: true, option: 'A. 巴黎' });
	});

	test('阶段3：答案给单个字母 B 时按下标命中', () => {
		assert.deepEqual(m.resolveSingle(['B'], ['选项A文本', '选项B文本']), { finish: true, option: '选项B文本' });
		assert.deepEqual(m.resolveSingle(['D'], ['甲', '乙', '丙', '丁']), { finish: true, option: '丁' });
	});

	test('阶段3：答案里的换行会被去掉，字母仍能命中', () => {
		assert.deepEqual(m.resolveSingle(['B\n'], ['甲', '乙']), { finish: true, option: '乙' });
	});

	test('阶段3：小写字母不命中（isPlainAnswer 要求 [A-Z]）', () => {
		const r = m.resolveSingle(['b'], ['甲', '乙']);
		assert.equal(r.finish, false);
		assert.deepEqual(r.allAnswer, ['b']);
	});

	test('阶段3：字母超出选项范围时不命中', () => {
		assert.equal(m.resolveSingle(['E'], ['甲', '乙']).finish, false);
	});

	test('阶段2：只有相似文本能命中时，取相似度最高且 > 0.6 的选项', () => {
		const r = m.resolveSingle(['巴黎是法国的首都'], ['巴黎是法国的首都城市', '伦敦']);
		assert.equal(r.finish, true);
		assert.equal(r.option, '巴黎是法国的首都城市');
		assert.deepEqual(r.ratings, [0.875, 0]);
	});

	test('阶段2 的阈值是严格大于 0.6：相似度恰好 0.6 不命中', () => {
		const r = m.resolveSingle(['abcd'], ['abcdwxyz', '巴黎']);
		assert.equal(r.finish, false);
		assert.deepEqual(r.allAnswer, ['abcd']);
	});

	test('阶段4：多片段答案合并后与完整选项精确命中', () => {
		assert.deepEqual(m.resolveSingle(['听党指挥#能打胜仗#作风优良'], ['听党指挥能打胜仗作风优良', '其他']), {
			finish: true,
			option: '听党指挥能打胜仗作风优良'
		});
	});

	test('反直觉：多片段只覆盖一部分时，短选项仍可能因相似度 0.778 > 0.6 而命中（源码注释的断言并不总成立）', () => {
		const r = m.resolveSingle(['听党指挥#能打胜仗'], ['听党指挥能打胜仗作风优良']);
		assert.equal(r.finish, true);
		assert.equal(r.option, '听党指挥能打胜仗作风优良');
		assert.ok(r.ratings[0] > 0.6 && r.ratings[0] < 0.8);
	});

	test('多片段只覆盖一部分且选项很长时相似度跌破阈值，不命中', () => {
		const r = m.resolveSingle(['听党指挥#能打胜仗'], ['听党指挥能打胜仗作风优良并且全心全意为人民服务']);
		assert.equal(r.finish, false);
		assert.deepEqual(r.allAnswer, ['听党指挥', '能打胜仗']);
	});

	test('未命中时返回 finish:false 以及拆分后的答案与去标签后的选项', () => {
		const r = m.resolveSingle([], ['巴黎']);
		assert.equal(r.finish, false);
		assert.deepEqual(r.allAnswer, []);
		assert.deepEqual(r.options, ['巴黎']);
	});
});

/* ==========================================================================
 * resolveMultiple
 * ==========================================================================*/
describe('resolveMultiple —— 多选题匹配', () => {
	test('答案给多个完整选项文本时全部命中', () => {
		const r = m.resolveMultiple(['巴黎#伦敦'], ['巴黎', '伦敦', '柏林']);
		assert.equal(r.finish, true);
		assert.deepEqual(r.options, ['巴黎', '伦敦']);
	});

	test('JSON 数组形式的答案同样命中', () => {
		const r = m.resolveMultiple(['["甲","乙"]'], ['甲', '乙', '丙']);
		assert.equal(r.finish, true);
		assert.deepEqual(r.options, ['甲', '乙']);
	});

	test('答案给 A#B#C 这种字母串时走 plainOptions 兜底', () => {
		const r = m.resolveMultiple(['A#B#C'], ['甲', '乙', '丙', '丁']);
		assert.equal(r.finish, true);
		assert.deepEqual(r.plainOptions, ['甲', '乙', '丙']);
		assert.equal(r.options, undefined);
	});

	test('字母串带逗号/顿号也能兜底（分隔符字符映射不到选项下标，被跳过）', () => {
		assert.deepEqual(m.resolveMultiple(['A,B'], ['甲', '乙', '丙', '丁']).plainOptions, ['甲', '乙']);
		assert.deepEqual(m.resolveMultiple(['A、B、C'], ['甲', '乙', '丙', '丁']).plainOptions, ['甲', '乙', '丙']);
	});

	test('带标签的字母串兜底命中原选项文本', () => {
		assert.deepEqual(m.resolveMultiple(['A#B'], ['A. 巴黎', 'B. 伦敦']).plainOptions, ['A. 巴黎', 'B. 伦敦']);
	});

	test('一字之差的选项不会被全选（消歧生效）', () => {
		const r = m.resolveMultiple(['计算机网络'], ['计算机网络', '计算机网络原理']);
		assert.equal(r.finish, true);
		assert.deepEqual(r.options, ['计算机网络']);
	});

	test('选项文本互为超串时只保留匹配度更高的', () => {
		const r = m.resolveMultiple(['巴黎'], ['巴黎', '法国巴黎', '伦敦']);
		assert.equal(r.finish, true);
		assert.deepEqual(r.options, ['巴黎']);
	});

	test('完全不匹配时 finish:false', () => {
		assert.equal(m.resolveMultiple(['完全无关的答案'], ['巴黎', '伦敦']).finish, false);
		assert.equal(m.resolveMultiple([], ['巴黎']).finish, false);
	});

	test('统计字段：similarCount / similarSum / ratings 与命中选项对应', () => {
		const r = m.resolveMultiple(['巴黎#伦敦'], ['巴黎', '伦敦', '柏林']);
		const g = r.groups[0];
		assert.deepEqual(g.options, ['巴黎', '伦敦']);
		assert.deepEqual(g.ratings, [1, 1]);
		assert.equal(g.similarCount, 2);
		assert.equal(g.similarSum, 2);
	});
});

/* ==========================================================================
 * resolveJudgement
 * ==========================================================================*/
describe('resolveJudgement —— 判断题匹配', () => {
	test('答案是"正确"而选项是"对"/"错"时命中"对"', () => {
		assert.deepEqual(m.resolveJudgement([['正确']], ['对', '错']), { finish: true, option: '对' });
	});

	test('答案是"错误"时命中"错"', () => {
		assert.deepEqual(m.resolveJudgement([['错误']], ['对', '错']), { finish: true, option: '错' });
	});

	test('√ / × / T / F / 0 / 1 等词表符号都能命中', () => {
		assert.deepEqual(m.resolveJudgement([['√']], ['是', '否']), { finish: true, option: '是' });
		assert.deepEqual(m.resolveJudgement([['T']], ['对', '错']), { finish: true, option: '对' });
		assert.deepEqual(m.resolveJudgement([['错误']], ['√', 'X']), { finish: true, option: 'X' });
		assert.deepEqual(m.resolveJudgement([['1']], ['0', '1']), { finish: true, option: '1' });
	});

	test('【重要结论】答案是字母 A 时必须 finish:false —— 判断题不解析字母答案', () => {
		// 字母既不在 CORRECT_WORDS 也不在 INCORRECT_WORDS 中，且匹配是整串相等
		assert.deepEqual(m.resolveJudgement([['A']], ['对', '错']), { finish: false });
		// 即使选项就是规范的"正确/错误"文本，字母答案依旧不命中
		assert.deepEqual(m.resolveJudgement([['A']], ['正确', '错误']), { finish: false });
		assert.deepEqual(m.resolveJudgement([['B']], ['对', '错']), { finish: false });
	});

	test('答案文本与选项都必须与词表"整串归一化相等"，不是包含', () => {
		assert.deepEqual(m.resolveJudgement([['不确定']], ['对', '错']), { finish: false });
		assert.deepEqual(m.resolveJudgement([['答案是正确']], ['对', '错']), { finish: false });
	});

	test('反直觉：某答案组命中词表但没有任何选项对得上时，立即 finish:false，不再尝试后续答案组', () => {
		// 第 1 组 '对' 命中 CORRECT_WORDS，但选项 ['甲','错'] 都不是词表项 → 立刻返回 false；
		// 第 2 组 '错误' 本来可以命中 '错'，却被跳过。
		assert.deepEqual(m.resolveJudgement([['对'], ['错误']], ['甲', '错']), { finish: false });
	});

	test('答案组未命中词表时继续尝试下一组', () => {
		assert.deepEqual(m.resolveJudgement([['无关文本'], ['错误']], ['甲', '错']), { finish: true, option: '错' });
	});

	test('isJudgementOptions：仅两个选项且分别为对/错性质时为 true', () => {
		assert.equal(m.isJudgementOptions(['对', '错']), true);
		assert.equal(m.isJudgementOptions(['正确', '错误']), true);
		assert.equal(m.isJudgementOptions(['true', 'false']), true);
		assert.equal(m.isJudgementOptions(['√', '×']), true);
		assert.equal(m.isJudgementOptions(['巴黎', '伦敦']), false);
		assert.equal(m.isJudgementOptions(['对', '伦敦']), false);
		assert.equal(m.isJudgementOptions(['对', '错', '不知道']), false);
		assert.equal(m.isJudgementOptions(['对']), false);
	});

	test('CORRECT_WORDS / INCORRECT_WORDS 与 OCS 原实现一致', () => {
		assert.deepEqual(m.CORRECT_WORDS, ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'True', 'T', 'yes', '1']);
		assert.deepEqual(m.INCORRECT_WORDS, [
			'非',
			'否',
			'错',
			'错误',
			'×',
			'X',
			'错的',
			'不对',
			'不正确的',
			'不正确',
			'不是',
			'不是的',
			'false',
			'False',
			'F',
			'no',
			'0'
		]);
	});
});

/* ==========================================================================
 * resolveCompletion
 * ==========================================================================*/
describe('resolveCompletion —— 填空题匹配', () => {
	test('填空数为 1 时任意单答案都能命中', () => {
		assert.deepEqual(m.resolveCompletion([['巴黎']], 1), { finish: true, answers: ['巴黎'] });
		assert.deepEqual(m.resolveCompletion([['一段很长的答案文本']], 1), { finish: true, answers: ['一段很长的答案文本'] });
	});

	test('填空数为 1 而答案组有多段时，用空格合并为一段', () => {
		assert.deepEqual(m.resolveCompletion([['巴黎', '伦敦']], 1), { finish: true, answers: ['巴黎 伦敦'] });
	});

	test('答案数量与填空数一致时按原样命中', () => {
		assert.deepEqual(m.resolveCompletion([['甲', '乙']], 2), { finish: true, answers: ['甲', '乙'] });
		assert.deepEqual(m.resolveCompletion([['答案一===答案二===答案三']], 3), {
			finish: true,
			answers: ['答案一', '答案二', '答案三']
		});
		assert.deepEqual(m.resolveCompletion([['["甲","乙","丙"]']], 3), { finish: true, answers: ['甲', '乙', '丙'] });
	});

	test('填空数为 3 而答案只给了 1 段时不应命中', () => {
		assert.deepEqual(m.resolveCompletion([['只有一段']], 3), { finish: false });
	});

	test('前一组数量对不上时继续尝试后面的答案组', () => {
		assert.deepEqual(m.resolveCompletion([['只有一段'], ['甲#乙#丙']], 3), { finish: true, answers: ['甲', '乙', '丙'] });
	});

	test('答案组为空时不命中', () => {
		assert.deepEqual(m.resolveCompletion([[]], 1), { finish: false });
		assert.deepEqual(m.resolveCompletion([], 1), { finish: false });
	});
});

/* ==========================================================================
 * defaultWorkTypeResolver
 * ==========================================================================*/
describe('defaultWorkTypeResolver —— 题目类型推断（去 DOM 化）', () => {
	test('radio 数量为 2 → judgement', () => {
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 2 }), 'judgement');
	});

	test('radio 数量大于 2 → single', () => {
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 3 }), 'single');
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 4 }), 'single');
	});

	test('反直觉：radio 数量为 1 时既不是 judgement 也不是 single', () => {
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 1 }), undefined);
	});

	test('checkbox 数量大于 2 → multiple', () => {
		assert.equal(m.defaultWorkTypeResolver({ checkboxCount: 3 }), 'multiple');
		assert.equal(m.defaultWorkTypeResolver({ checkboxCount: 2 }), undefined);
	});

	test('textarea 数量 >= 1 → completion', () => {
		assert.equal(m.defaultWorkTypeResolver({ textareaCount: 1 }), 'completion');
		assert.equal(m.defaultWorkTypeResolver({ textareaCount: 3 }), 'completion');
	});

	test('优先级：判定顺序为 radio2 > radio>2 > checkbox>2 > textarea>=1', () => {
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 2, checkboxCount: 4, textareaCount: 2 }), 'judgement');
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 3, checkboxCount: 4, textareaCount: 2 }), 'single');
		assert.equal(m.defaultWorkTypeResolver({ checkboxCount: 4, textareaCount: 2 }), 'multiple');
		assert.equal(m.defaultWorkTypeResolver({ textareaCount: 1 }), 'completion');
	});

	test('全部为 0 或未传参数时返回 undefined', () => {
		assert.equal(m.defaultWorkTypeResolver({}), undefined);
		assert.equal(m.defaultWorkTypeResolver(), undefined);
		assert.equal(m.defaultWorkTypeResolver({ radioCount: 0, checkboxCount: 0, textareaCount: 0 }), undefined);
	});
});

/* ==========================================================================
 * 端到端：服务输出 → OCS 能否选中
 * ==========================================================================*/
describe('端到端：典型服务输出能否被 OCS 选中', () => {
	test('单选：服务输出完整选项文本 / 单字母 / 多片段 三种形态都能被选中', () => {
		const options = ['巴黎', '伦敦', '柏林'];
		assert.equal(m.resolveSingle(['巴黎'], options).option, '巴黎');
		assert.equal(m.resolveSingle(['A'], options).option, '巴黎');
		assert.equal(m.resolveSingle(['巴黎===伦敦'], options).option, '巴黎'); // 多片段合并后仍能命中第一个片段对应的选项
	});

	test('多选：服务输出 "A#B" 与 "甲#乙" 都能被选中', () => {
		assert.deepEqual(m.resolveMultiple(['A#B'], ['甲', '乙', '丙']).plainOptions, ['甲', '乙']);
		assert.deepEqual(m.resolveMultiple(['甲#乙'], ['甲', '乙', '丙']).options, ['甲', '乙']);
	});

	test('判断：服务输出必须给词表文本而不能给字母', () => {
		assert.equal(m.resolveJudgement([['正确']], ['对', '错']).finish, true);
		assert.equal(m.resolveJudgement([['A']], ['对', '错']).finish, false);
	});

	test('填空：服务输出段数必须等于填空数（填空数为 1 例外）', () => {
		assert.equal(m.resolveCompletion([['甲#乙#丙']], 2).finish, false);
		assert.equal(m.resolveCompletion([['甲#乙#丙']], 3).finish, true);
	});
});
