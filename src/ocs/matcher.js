/**
 * OCS（Online Course Script）官方"答案 → 选项"匹配算法的忠实移植版。
 *
 * 来源（逐行对照移植，语义等价）：
 *   - packages/core/src/core/utils/string.ts
 *       clearString / normalizeString / answerNormalizedMatch / answerSimilar /
 *       answerSimilarWithGap / answerExactMatch / removeRedundant
 *   - packages/core/src/core/worker/utils.ts
 *       splitAnswer / isPlainAnswer / resolvePlainAnswer / isProgramAnswer / defaultWorkTypeResolver
 *   - packages/core/src/core/worker/resolvers/single.ts       resolveSingle
 *   - packages/core/src/core/worker/resolvers/multiple.ts     resolveMultiple / disambiguateSimilarOptions
 *   - packages/core/src/core/worker/resolvers/judgement.ts    resolveJudgement / isJudgementOptions / CORRECT_WORDS / INCORRECT_WORDS
 *   - packages/core/src/core/worker/resolvers/completion.ts   resolveCompletion
 *
 * 本模块的用途：验证"我们服务输出的答案"能否被 OCS 正确选中。
 * 因此这里刻意保留 OCS 的一切行为（包括边界与可疑之处），不做"改良"：
 * 若与 OCS 行为不一致，本模块即失去价值。
 *
 * 零 npm 依赖，仅用 Node 内置能力（CommonJS）。
 * 唯一的外部依赖 string-similarity 已在下方自行复刻（见「string-similarity 行为复刻」段）。
 */

'use strict';

/* ============================================================================
 * string-similarity 行为复刻
 * ----------------------------------------------------------------------------
 * OCS packages/core 的依赖被 pnpm-lock.yaml 精确锁定为 string-similarity@4.0.4
 * （specifier ^4.0.4 → version 4.0.4），本段即对该版本 src/index.js 的行为复刻。
 *
 * 算法：Sørensen–Dice 系数（Dice's coefficient），对字符串的 **bigram 多重集合** 计算。
 *   - bigram = 相邻两字符的滑动窗口（substring(i, i+2)，i ∈ [0, len-2)），
 *     所以长度为 n 的字符串产生 n-1 个 bigram（含重复，是多重集合）。
 *   - Dice 公式：  dice = 2 * |A ∩ B| / (|A| + |B|)
 *     其中 A、B 分别为两侧的 bigram 多重集合，交集按"最小重数"计算
 *     （实现方式：先用 Map 统计 A 中各 bigram 的重数，遍历 B 时每命中一次就把
 *      重数减 1 并令 intersectionSize++，因此结果是 Σ_bigram min(countA, countB)）。
 *   - 实现里分母写成 `first.length + second.length - 2`，等价于 |A| + |B|
 *     （因为 |A| = len(first) - 1，|B| = len(second) - 1）。
 *
 * 必须保留的行为细节：
 *   1. 两侧字符串都先删除所有空白字符（/\s+/g → ''），这一步骤早于一切判断。
 *   2. 若删除空白后两串完全相同 → 直接返回 1。**因此 '' 与 '' 的相似度是 1**（边界行为）。
 *   3. 否则若任一侧长度 < 2 → 返回 0（0 或 1 个字符无法构成 bigram；此判断在相等判断之后）。
 *   4. 完全没有公共 bigram → 0；完全相同 → 1（可由公式自然得出）。
 *   5. findBestMatch(mainString, targetStrings) 返回
 *      { ratings: [{ target, rating }], bestMatch: { target, rating }, bestMatchIndex }。
 *      bestMatch 就是 ratings 中的元素（同一对象），且比较用严格 `>`，
 *      因此**并列最高分时取下标最小的那个**。
 *   6. findBestMatch 参数非法（非字符串 / 非数组 / 空数组 / 数组内含非字符串）时抛
 *      Error('Bad arguments: First argument should be a string, second should be an array of strings')。
 *
 * 注意：OCS 调用点传入的字符串都已先经 clearString/normalizeString 处理，
 * 长度 < 2 的答案（如单个字母）相似度恒为 0 —— 这正是 OCS 对单字母答案必须走
 * "纯 ABCD 兜底"分支的原因。
 * ==========================================================================*/

/** Dice 系数比较用的正规化字符串（删除空白）+ bigram 多重集合交集大小 */
function bigramIntersectionSize(first, second) {
	const firstBigrams = new Map();
	for (let i = 0; i < first.length - 1; i++) {
		const bigram = first.substring(i, i + 2);
		firstBigrams.set(bigram, firstBigrams.has(bigram) ? firstBigrams.get(bigram) + 1 : 1);
	}

	let intersectionSize = 0;
	for (let i = 0; i < second.length - 1; i++) {
		const bigram = second.substring(i, i + 2);
		const count = firstBigrams.has(bigram) ? firstBigrams.get(bigram) : 0;
		if (count > 0) {
			firstBigrams.set(bigram, count - 1);
			intersectionSize++;
		}
	}
	return intersectionSize;
}

/** string-similarity@4.0.4 compareTwoStrings 的复刻 */
function compareTwoStrings(first, second) {
	first = first.replace(/\s+/g, '');
	second = second.replace(/\s+/g, '');

	if (first === second) return 1; // identical or empty
	if (first.length < 2 || second.length < 2) return 0; // if either is a 0-letter or 1-letter string

	return (2.0 * bigramIntersectionSize(first, second)) / (first.length + second.length - 2);
}

/** string-similarity@4.0.4 areArgsValid 的复刻 */
function areArgsValid(mainString, targetStrings) {
	if (typeof mainString !== 'string') return false;
	if (!Array.isArray(targetStrings)) return false;
	if (!targetStrings.length) return false;
	if (targetStrings.find((s) => typeof s !== 'string')) return false;
	return true;
}

/** string-similarity@4.0.4 findBestMatch 的复刻 */
function findBestMatch(mainString, targetStrings) {
	if (!areArgsValid(mainString, targetStrings)) {
		throw new Error('Bad arguments: First argument should be a string, second should be an array of strings');
	}

	const ratings = [];
	let bestMatchIndex = 0;

	for (let i = 0; i < targetStrings.length; i++) {
		const currentTargetString = targetStrings[i];
		const currentRating = compareTwoStrings(mainString, currentTargetString);
		ratings.push({ target: currentTargetString, rating: currentRating });
		if (currentRating > ratings[bestMatchIndex].rating) {
			bestMatchIndex = i;
		}
	}

	const bestMatch = ratings[bestMatchIndex];

	return { ratings: ratings, bestMatch: bestMatch, bestMatchIndex: bestMatchIndex };
}

/* ============================================================================
 * 小工具
 * ==========================================================================*/

/** StringUtils.nowrap(str, '') 的等价实现：删除换行符 */
function nowrap(str, replaceStr) {
	return str?.replace(/\n/g, replaceStr) || '';
}

/* ============================================================================
 * packages/core/src/core/utils/string.ts
 * ==========================================================================*/

/**
 * 删除特殊字符, 并且全部转小写，只保留英文，数字，中文
 *
 * 注意（与直觉相反）：`exclude` 中的字符是"**保留**白名单"，不是要删除的字符。
 * 实现把它们拼进被否定的字符类 `[^...]` 里，所以出现在 exclude 中的字符不会被删除。
 * 另外该实现永远把 `①②③④⑤⑥⑦⑧⑨` 追加进白名单。
 *
 * exclude 元素是**原样**拼进 RegExp 字符类的（OCS 只传 '√'、'×'），
 * 这里保持原样拼接以维持完全一致的行为（传含 `]`/`-` 的字符串时同样会抛错/产生范围）。
 */
function clearString(str, ...exclude) {
	exclude.push(...['①②③④⑤⑥⑦⑧⑨']);
	return str
		.trim()
		.toLocaleLowerCase()
		.replace(RegExp(`[^\\u2E80-\\u9FFFA-Za-z0-9${exclude.join('')}]*`, 'g'), '');
}

/**
 * 归一化字符串：去除标点、空格、全角转半角后再 clearString
 * 用于精确匹配前预处理，忽略空白和标点差异
 *
 * 原文件里中文标点那一行的引号实际是 **ASCII 直引号**（U+0022/U+0027），
 * 不是全角引号；这里保持原样。
 */
function normalizeString(str) {
	return clearString(
		str
			.replace(/[，。！？；：""''、（）【】《》\s]/g, '') // 去除中文标点和空白
			.replace(/[,.\-!?;:'"()[\]<>]/g, '') // 去除英文标点
			.replace(/[ａ-ｚＡ-Ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角→半角
			.replace(/％/g, '%')
	);
}

/**
 * 删除题目选项中开头的冗余字符串
 *
 * 两条规则依次执行：
 * 1. `A.` / `A、` / `A)` 等带分隔符的选项标签：字母 + 分隔符 + 内容
 * 2. `A选项` / `C男女平等` 等字母直接紧跟中文的标签：字母 + 中文内容
 *    （仅当字母后紧跟中文时剥离，故 "TCP协议"、"CPU" 等字母串不被误删）
 */
function removeRedundant(str) {
	return (
		str
			?.trim()
			.replace(/^[A-Z]{1}[^A-Za-z0-9\u2E80-\u9FFF]+([A-Za-z0-9\u2E80-\u9FFF]+)/, '$1')
			.replace(/^[A-Z]{1}([\u2E80-\u9FFF][A-Za-z0-9\u2E80-\u9FFF]*)/, '$1') || ''
	);
}

/**
 * 归一化精确匹配模式
 * 对答案和选项进行归一化处理后精确比对
 * 解决"多一个标点符号就匹配不上"的问题
 *
 * 方向说明（与 resolveMultiple 保持一致）：仅取"答案⊇选项"或相等，不取"选项⊇答案"，
 * 避免 "TCP" 误选 "TCP/IP协议"、"相对论" 误选 "爱因斯坦的相对论" 等语义不一致的选项。
 *
 * 返回值是**原始选项字符串**（不是归一化后的），按匹配等级（2 精确 > 1 包含）降序排列；
 * 等级相同的选项保持原有相对顺序（Array#sort 在现代 V8 是稳定排序）。
 * 空字符串选项（归一化后为空）等级恒为 0，永不返回。
 */
function answerNormalizedMatch(answers, options) {
	const _answers = answers.map(removeRedundant).map(normalizeString);
	const _options = options.map(removeRedundant).map(normalizeString);

	return _answers.length !== 0
		? _options
				.map((opt, i) => {
					let level = 0;
					if (opt) {
						for (const ans of _answers) {
							if (ans === opt) {
								level = 2;
								break;
							} else if (ans.includes(opt)) {
								level = 1;
							}
						}
					}
					return { opt, original: options[i], level };
				})
				.filter(({ level }) => level > 0)
				.sort((a, b) => b.level - a.level)
				.map(({ original }) => original)
		: [];
}

/**
 * 答案相似度匹配 , 返回相似度对象列表（每个选项一个 { target, rating }）
 *
 * 相似度计算算法 : string-similarity@4.0.4（见文件顶部复刻段）
 *
 * @example
 * answerSimilar( ['3'], ['1+2','3','4','错误的选项'] ) // [0, 1, 0, 0]
 * answerSimilar( ['hello world','console.log("hello world")'], ['console.log("hello world")','hello world','1','错误的选项'] ) // [1, 1, 0, 0]
 *
 * 注意：`target` 是该选项在**答案列表**中的最佳匹配答案；
 * 即使 rating 为 0，target 也仍然是最佳匹配项（findBestMatch 的 bestMatchIndex 默认 0），
 * 只有"答案列表为空"或"选项归一化后为空串"时 target 才是 ''。
 */
function answerSimilar(answers, options) {
	const _answers = answers.map(removeRedundant).map((a) => clearString(a));
	const _options = options.map(removeRedundant).map((o) => clearString(o));

	const similar =
		_answers.length !== 0
			? _options.map((option) => {
					if (option.trim() === '') {
						return { rating: 0, target: '' };
					}
					return findBestMatch(option, _answers).bestMatch;
			  })
			: _options.map(() => ({ rating: 0, target: '' }));

	return similar;
}

/** 带领先度的相似度评分（MatchRating）：在 Rating 之上增加 gap 字段 */
function computeGap(ratings) {
	// 计算领先度：最高分与次高分之间的差异
	const sortedRatings = [...ratings].sort((a, b) => b.rating - a.rating);
	const maxRating = sortedRatings[0]?.rating ?? 0;
	let secondRating = 0;
	// 找到与最高分不同的次高分（可能多个选项同分，需要找到真正不同的那个）
	for (let i = 1; i < sortedRatings.length; i++) {
		if (sortedRatings[i].rating < maxRating) {
			secondRating = sortedRatings[i].rating;
			break;
		}
	}
	return { maxRating, secondRating };
}

/**
 * 带领先度消歧的相似度匹配
 * 返回每个选项的相似度 + 与次优选项的领先度（gap）
 * 用于解决"相似选项全选"的问题
 *
 * gap 仅赋给取得最高分的选项（并列最高分者都有 gap），其余为 0。
 * 若只有 1 个选项，secondRating 为 0，故 gap === maxRating。
 */
function answerSimilarWithGap(answers, options) {
	const _answers = answers.map(removeRedundant).map((a) => clearString(a));
	const _options = options.map(removeRedundant).map((o) => clearString(o));

	if (_answers.length === 0) {
		return _options.map(() => ({ rating: 0, target: '', gap: 0 }));
	}

	const ratings = _options.map((option) => {
		if (option.trim() === '') {
			return { rating: 0, target: '' };
		}
		return findBestMatch(option, _answers).bestMatch;
	});

	const { maxRating, secondRating } = computeGap(ratings);

	return ratings.map((r) => ({
		...r,
		gap: r.rating === maxRating ? maxRating - secondRating : 0
	}));
}

/**
 * 	精准匹配模式，返回符合的选项字符串列表
 * @param answers	答案列表
 * @param options	选项列表
 */
function answerExactMatch(answers, options) {
	const _answers = answers.map(removeRedundant);
	const _options = options.map(removeRedundant);

	const result =
		_answers.length !== 0
			? _options.filter((option) => {
					return _answers.find((answer) => answer.trim() === option.trim());
			  })
			: [];

	return result;
}

/* ============================================================================
 * packages/core/src/core/worker/utils.ts
 * ==========================================================================*/

/**
 * 默认题目类型解析器 —— **去 DOM 化改写**
 *
 * 原实现接收 WorkContext，内部用 `option.querySelector(selector)` 统计
 * 每个选项内是否含有 radio / checkbox / textarea 元素：
 *   count('[type="radio"]') === 2  → 'judgement'
 *   count('[type="radio"]') > 2    → 'single'
 *   count('[type="checkbox"]') > 2 → 'multiple'
 *   count('textarea') >= 1         → 'completion'
 *   否则                            → undefined
 * 本模块不依赖 DOM，等价改写为直接接收三个"含该元素的选项个数"：
 *   { radioCount, checkboxCount, textareaCount }
 * 判定分支与顺序、阈值（=== 2 / > 2 / > 2 / >= 1）与原实现完全一致。
 * 注意：radioCount === 1 时既不算 judgement 也不算 single，会继续向下判断。
 */
function defaultWorkTypeResolver(ctx = {}) {
	const { radioCount = 0, checkboxCount = 0, textareaCount = 0 } = ctx;
	return radioCount === 2
		? 'judgement'
		: radioCount > 2
		? 'single'
		: checkboxCount > 2
		? 'multiple'
		: textareaCount >= 1
		? 'completion'
		: undefined;
}

/** 判断答案是否为A-Z的文本, 并且字符序号依次递增, 并且 每个字符是否都只出现了一次 */
function isPlainAnswer(answer) {
	answer = answer.trim();
	if (answer.length > 8 || !/[A-Z]/.test(answer)) {
		return false;
	}
	const counter = {};
	let min = 0;
	for (let i = 0; i < answer.length; i++) {
		if (answer.charCodeAt(i) < min) {
			return false;
		}
		min = answer.charCodeAt(i);
		counter[min] = (counter[min] || 0) + 1;
	}
	// 判断每个字符是否都只出现了一次
	for (const key in counter) {
		if (counter[key] !== 1) {
			return false;
		}
	}

	return true;
}

/**
 * 判断是否为纯ABCD多选答案，但是中间存在分隔符
 * @param answer  答案
 * @returns 合法时返回清洗后的字母串，否则返回 undefined（不是 null）
 */
function resolvePlainAnswer(answer) {
	const resolve = answer
		.trim()
		.replace(/[,，.。．、 #]/g, '')
		.trim();
	if (isPlainAnswer(resolve)) {
		return resolve;
	}
}

/**
 * 检测答案是否为一段程序代码
 *
 * 程序题的题库答案是一段代码，其中的 `;` `|` `；` 是代码语法（语句终止符、按位或运算符），
 * 而非答案分隔符。本函数通过代码关键字、运算符、语句终止符等特征综合判定，
 * 命中则在 splitAnswer 中取消 `;` `|` `；` 作为分隔符，避免代码被错误拆分。
 *
 * 仅当答案中存在 `;` `|` `；` 时才需要判定（否则无需取消任何分隔符），以此降低误判。
 *
 * 计分：强特征每个 +2，中等特征每个 +1，`{`与`}`同时出现 +1，含 `;` +1；总分 >= 2 判定为程序。
 * 注意 `#` 不在被取消的分隔符之列，故 `#include` 仍会被 `#` 拆分（OCS 原有行为）。
 *
 * @param answer 答案文本
 */
function isProgramAnswer(answer) {
	const code = (answer ?? '').trim();
	if (!code) return false;
	// 不含 ; | ； 时无需取消分隔符，直接返回
	if (!/[;|；]/.test(code)) return false;

	let score = 0;

	// 强特征：单独命中即可判定为程序
	const strong = [
		/#include\s*[<"]/,
		/#define\s+\w/,
		/#!\//,
		/\b(?:int|void|float|double|char|long|short)\s+main\s*\(/,
		/\bfunction\s+\w+\s*\(/,
		/\bdef\s+\w+\s*\(/,
		/\bpublic\s+(?:class|static|void|int|float|double|String|final)\b/,
		/\bprivate\s+(?:class|static|void|int|float|double|String|final)\b/,
		/\bprotected\s+(?:class|static|void|int|float|double|String|final)\b/,
		/\bprintf\s*\(/,
		/\bscanf\s*\(/,
		/\bcout\s*<</,
		/\bcin\s*>>/,
		/System\.out\./,
		/console\.log\s*\(/,
		/\bpackage\s+[\w.]+\s*;/,
		/\bimport\s+[\w.*]+\s*;/,
		/\bclass\s+\w+\s*\{/,
		/\bstruct\s+\w+\s*\{/
	];
	for (const re of strong) if (re.test(code)) score += 2;

	// 中等特征
	const medium = [
		/=>/,
		/->/,
		/::/,
		/\+\+/,
		/--/,
		/[+\-*/%]=/,
		/\bnew\s+\w+\s*\(/,
		/\bfor\s*\(/,
		/\bwhile\s*\(/,
		/\bif\s*\(/,
		/\bswitch\s*\(/,
		/\btypedef\s+/,
		/\b(?:int|float|double|char|void|bool|boolean|long|short|String|auto|const|let|var)\s+\w+/,
		/\bsizeof\s*\(/,
		/\bmalloc\s*\(/,
		/\bfree\s*\(/,
		/\bcout\b/,
		/\bcin\b/
	];
	for (const re of medium) if (re.test(code)) score += 1;

	// 结构特征：花括号块
	if (/\{/.test(code) && /\}/.test(code)) score += 1;
	// 语句终止符 ; 至少 1 个
	if (/;/.test(code)) score += 1;

	return score >= 2;
}

/** 默认答案分隔符（与 OCS 原实现一致） */
const DEFAULT_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'];

/**
 * 分割答案
 *
 * 行为细节（全部保留）：
 * 1. 先 trim；空串 → []。
 * 2. separators 为 undefined 时用默认值；传入空数组时也回退到默认值；
 *    之后过滤掉 strip 后为空的元素。
 * 3. 命中 isProgramAnswer 时，从分隔符中移除 ';' '|' '；'。
 * 4. **优先按 JSON 数组解析**：JSON.parse 成功且结果是数组时，
 *    直接 String() 化 + trim + 去空元素返回。
 *    注意：若 JSON.parse 成功但结果**不是数组**（例如 `'123'`、`'"A#B"'`、`'true'`），
 *    既不返回也不进入 catch 分支，最终落到末尾 `return [answer]` —— 即**完全不做分隔符拆分**。
 * 5. 只有 JSON.parse 抛错时才逐个尝试分隔符，返回第一个能拆出多段的分隔符的拆分结果
 *    （顺序即 separators 顺序），每段 trim 并去掉空段。
 * 6. 都不命中 → [answer]（单元素，内容为 trim 后的原文）。
 */
function splitAnswer(answer, separators = DEFAULT_SEPARATORS) {
	answer = answer.trim();
	if (answer.length === 0) {
		return [];
	}
	separators = separators.length === 0 ? DEFAULT_SEPARATORS : separators;
	separators = separators.filter((el) => el.trim().length > 0);

	// 程序题答案：; | ； 是代码语法而非答案分隔符，检测到程序时取消这些分隔符
	if (isProgramAnswer(answer)) {
		separators = separators.filter((el) => el !== ';' && el !== '|' && el !== '；');
	}

	try {
		// 如果是 json 格式的多选答案
		const json = JSON.parse(answer);
		if (Array.isArray(json)) {
			return json
				.map(String)
				.map((el) => el.trim())
				.filter((el) => el.length > 0);
		}
	} catch {
		for (const sep of separators) {
			if (answer.split(sep).length > 1) {
				return answer
					.split(sep)
					.map((el) => el.trim())
					.filter((el) => el.length > 0);
			}
		}
	}

	return [answer];
}

/* ============================================================================
 * packages/core/src/core/worker/resolvers/single.ts
 * ==========================================================================*/

/**
 * 单选题匹配算法（自适应）
 *
 * 四阶段自动匹配，无需手动选择模式：
 * 1. 归一化精确匹配 — 去除标点/空格/全角半角差异后精确比对
 * 2. 相似匹配 — 取所有选项中相似度最高且**严格大于 0.6** 的那个
 * 3. 纯ABCD答案兜底 — 仅接受单字母（多字母视为多选答案，不在此处理）
 * 4. 多片段答案适配 — 题库答案被分隔符拆成多片段时，合并为一个答案后重新调用本算法
 *
 * 返回值：
 *   { finish: true, option }                    阶段 1/3/4 命中
 *   { finish: true, option, ratings }           阶段 2 命中
 *   { finish: false, allAnswer, options }       未命中（allAnswer 为拆分后的答案片段，
 *                                               options 为 removeRedundant 后的选项文本）
 *
 * @param answers  所有题库返回的答案列表
 * @param options   选项文本列表
 * @param separators 答案分隔符
 */
function resolveSingle(answers, options, separators) {
	const allAnswer = answers.map((a) => splitAnswer(a, separators)).flat();
	const optionStrings = options.map(removeRedundant);

	// ========== 阶段1: 归一化精确匹配 ==========
	const normalizedResult = answerNormalizedMatch(allAnswer, optionStrings);
	if (normalizedResult.length) {
		const index = optionStrings.findIndex((opt) => opt === normalizedResult[0]);
		if (index !== -1) {
			return { finish: true, option: options[index] };
		}
	}

	// ========== 阶段2: 相似匹配（取最优） ==========
	const ratings = answerSimilar(allAnswer, optionStrings);

	let bestIndex = -1;
	let bestRating = 0;
	ratings.forEach((r, i) => {
		if (r.rating > bestRating) {
			bestRating = r.rating;
			bestIndex = i;
		}
	});

	if (bestIndex !== -1 && bestRating > 0.6) {
		return {
			finish: true,
			option: options[bestIndex],
			ratings: ratings.map((r) => r.rating)
		};
	}

	// ========== 阶段3: 纯ABCD答案兜底 ==========
	for (const answer of allAnswer) {
		const ans = resolvePlainAnswer(nowrap(answer, '').trim());
		// 单选仅允许单字母答案（多字母视为多选答案，不在此处理）
		if (ans && ans.length === 1) {
			const index = ans.charCodeAt(0) - 65;
			if (optionStrings[index] !== undefined) {
				return { finish: true, option: options[index] };
			}
		}
	}

	// ========== 阶段4: 多片段答案适配（最后阶段） ==========
	// 当题库答案被分隔符拆成多个片段（如 "听党指挥 # 能打胜仗 # 作风优良"）时，
	// 单选的正确选项应是这些片段拼接后的整体。此处将所有片段合并为一个答案，
	// 再重新走一遍单选匹配流程：完整覆盖时阶段1即可精确命中；若仅覆盖部分片段，
	// 合并后的答案既无法精确匹配、相似度也达不到阈值，从而返回未命中。
	// （实测注意：相似度是否低于阈值取决于长度比，见测试中的对应用例。）
	if (allAnswer.length > 1) {
		const merged = allAnswer.join('');
		const r = resolveSingle([merged], options, separators);
		if (r.finish) {
			return r;
		}
	}

	return { finish: false, allAnswer, options: optionStrings };
}

/* ============================================================================
 * packages/core/src/core/worker/resolvers/multiple.ts
 * ==========================================================================*/

/**
 * 多选题匹配算法（自适应）
 *
 * 1. 归一化匹配（单向 答案⊇选项）— 仅当答案包含选项（或归一化相等）才视为命中
 * 2. 相似匹配 + 领先度消歧 — 候选选项两两比较，文本相似时只保留匹配度更高的
 * 3. 纯ABCD答案兜底
 *
 * 返回：
 *   { finish: true, options, groups }      正常匹配命中
 *   { finish: true, plainOptions }         纯字母兜底命中
 *   { finish: false }                      未命中
 *
 * @param resultAnswers  每个题库结果的原始答案字符串列表
 * @param options         选项文本列表
 * @param separators      答案分隔符
 */
function resolveMultiple(resultAnswers, options, separators) {
	const optionStrings = options.map(removeRedundant);

	const groups = [];

	for (let i = 0; i < resultAnswers.length; i++) {
		const answers = splitAnswer(resultAnswers[i].trim(), separators);

		// 阶段1: 归一化匹配（包含式）
		const normalizedGroup = {
			options: [],
			answers: [],
			ratings: [],
			similarSum: 0,
			similarCount: 0
		};
		const normalizedOptions = answerNormalizedMatch(answers, optionStrings);
		for (const opt of normalizedOptions) {
			// answerNormalizedMatch 返回的是 optionStrings（已 removeRedundant）中的字符串，
			// 故在 optionStrings 中定位索引，再映射回原始 options，避免前缀剥离后查找不到
			const idx = optionStrings.indexOf(opt);
			if (idx !== -1) {
				// 严格方向：仅当 答案⊇选项（或归一化相等）时才视为命中，
				// 避免 "TCP" 误选 "TCP/IP协议" 等选项⊇答案的误匹配
				const matchedAns = answers.find((a) => {
					const na = normalizeString(removeRedundant(a));
					const no = normalizeString(removeRedundant(opt));
					return na === no || na.includes(no);
				});
				if (!matchedAns) continue;
				normalizedGroup.options.push(options[idx]);
				normalizedGroup.answers.push(matchedAns);
				// 归一化匹配中，答案与选项完全归一化相等的评分更高
				const na = normalizeString(removeRedundant(matchedAns));
				const no = normalizeString(removeRedundant(opt));
				const rating = na === no ? 1 : 0.8;
				normalizedGroup.ratings.push(rating);
				normalizedGroup.similarSum += rating;
				normalizedGroup.similarCount += 1;
			}
		}
		// 归一化匹配结果也需要消歧
		// （注意：这里用 indexOf 找回下标，若同一选项文本重复出现，两个位置会映射到同一个下标）
		const normalizedDisambiguated = disambiguateSimilarOptions(normalizedGroup.options, normalizedGroup.ratings);
		const normalizedKeptIndices = normalizedDisambiguated.map((opt) => normalizedGroup.options.indexOf(opt));
		normalizedGroup.options = normalizedDisambiguated;
		normalizedGroup.answers = normalizedKeptIndices.map((idx) => normalizedGroup.answers[idx]);
		normalizedGroup.ratings = normalizedKeptIndices.map((idx) => normalizedGroup.ratings[idx]);
		normalizedGroup.similarCount = normalizedGroup.options.length;
		normalizedGroup.similarSum = normalizedGroup.ratings.reduce((a, b) => a + b, 0);

		// 相似度匹配
		const ratingGroup = { options: [], answers: [], ratings: [], similarSum: 0, similarCount: 0 };
		const ratings = answerSimilarWithGap(answers, optionStrings);
		for (let j = 0; j < ratings.length; j++) {
			if (ratings[j].rating > 0.6) {
				ratingGroup.options.push(options[j]);
				ratingGroup.answers.push(ratings[j].target);
				ratingGroup.ratings.push(ratings[j].rating);
				ratingGroup.similarSum += ratings[j].rating;
				ratingGroup.similarCount += 1;
			}
		}

		// 领先度消歧
		const disambiguated = disambiguateSimilarOptions(ratingGroup.options, ratingGroup.ratings);
		const keptIndices = disambiguated.map((opt) => ratingGroup.options.indexOf(opt));
		ratingGroup.options = disambiguated;
		ratingGroup.answers = keptIndices.map((idx) => ratingGroup.answers[idx]);
		ratingGroup.ratings = keptIndices.map((idx) => ratingGroup.ratings[idx]);
		ratingGroup.similarCount = ratingGroup.options.length;
		ratingGroup.similarSum = ratingGroup.ratings.reduce((a, b) => a + b, 0);

		// 选匹配度最高的（similarCount 权重 100 > 相似度和，故先比个数；并列时稳定排序取 normalizedGroup）
		const best = [normalizedGroup, ratingGroup].sort(
			(a, b) => b.similarCount * 100 + b.similarSum - a.similarCount * 100 - a.similarSum
		)[0];
		groups[i] = best;
	}

	const sorted = groups
		.filter((g) => g.similarCount !== 0)
		.sort((a, b) => {
			const bsc = b.similarCount * 100;
			const asc = a.similarCount * 100;
			return bsc + b.similarSum - asc - a.similarSum;
		});

	if (sorted[0]) {
		return { finish: true, options: sorted[0].options, groups: sorted };
	}

	// 纯ABCD答案兜底
	// 注意：判定用 resolvePlainAnswer（会剔除 ,，.。．、 # 与空格），
	// 但下面遍历的是**原始字符串** ans 而不是清洗结果。
	// 实测无害：被剔除的那些分隔符字符的 charCode 都落在 A-Z(65~90) 之外，
	// charCode - 65 得到负数或 > 25 的下标，options[...] 为 undefined 直接被跳过，
	// 因此 'A,B'、'A、B'、'A.B'、'A B' 都能像 'A#B' 一样逐个字母命中。
	// （这是 OCS 的既有行为，此处原样保留；注意这也是它与"字母串必须严格递增"校验的耦合点。）
	const plainOptions = [];
	for (const answer of resultAnswers) {
		const ans = nowrap(answer, '').trim();
		if (resolvePlainAnswer(ans)) {
			for (const char of ans) {
				const index = char.charCodeAt(0) - 65;
				if (options[index] !== undefined) {
					plainOptions.push(options[index]);
				}
			}
		}
	}

	if (plainOptions.length) {
		return { finish: true, plainOptions: [...new Set(plainOptions)] };
	}

	return { finish: false };
}

/**
 * 领先度消歧：候选选项两两比较文本相似度，如果非常相似则只保留与答案匹配度更高的
 * 解决多选题"一字之差的选项全选"问题
 *
 * 示例：
 *   选项A "计算机网络" rating=1.0，选项B "计算机网络原理" rating=0.8
 *   二者文本相似度 > 0.6 → 只保留 rating 更高的 A
 *
 * 注意：
 *  - 选项数 <= 1 时原样返回。
 *  - 相似度为严格 `> threshold` 才算"非常相似"。
 *  - ratings 相等时保留下标较小者（`ratings[i] >= ratings[j]` 删除 j）。
 *  - 内层循环中若 i 被淘汰会 `break` 跳出（i 已失效）。
 *  - 返回的是传入的 option 字符串（原始文本），不是归一化后的文本。
 */
function disambiguateSimilarOptions(options, ratings, threshold = 0.6) {
	if (options.length <= 1) return options;

	const normalized = options.map((o) => normalizeString(removeRedundant(o)));
	const eliminated = new Set();

	for (let i = 0; i < options.length; i++) {
		if (eliminated.has(i)) continue;
		for (let j = i + 1; j < options.length; j++) {
			if (eliminated.has(j)) continue;
			const pairwise = findBestMatch(normalized[i], [normalized[j]]).bestMatch.rating;
			if (pairwise > threshold) {
				if (ratings[i] >= ratings[j]) {
					eliminated.add(j);
				} else {
					eliminated.add(i);
					break;
				}
			}
		}
	}

	return options.filter((_, i) => !eliminated.has(i));
}

/* ============================================================================
 * packages/core/src/core/worker/resolvers/judgement.ts
 * ==========================================================================*/

const CORRECT_WORDS = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'True', 'T', 'yes', '1'];

const INCORRECT_WORDS = [
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
];

/**
 * 判断题匹配算法
 *
 * 遍历题库答案，判断答案文本是否包含正确/错误关键词，
 * 然后在选项中匹配对应关键词的选项。
 *
 * 注意几个反直觉之处（均保留）：
 *  - 匹配是"整串归一化后完全相等"，不是"包含"：答案 '正确' 只能命中选项 '对'/'√'/'是的'… 等词表中的**某个词**，
 *    而不是包含这些词的任意文本。
 *  - 答案若为字母（如 'A'、'B'）不会命中任何关键词 → finish:false（字母在判断题里不被解析）。
 *  - 一旦某个答案组命中了正确/错误关键词，但没有任何选项能对上，会**立即** return finish:false，
 *    不再尝试后面的答案组。
 *
 * @param answerGroups  每个题库的答案列表
 * @param options        选项文本列表
 */
function resolveJudgement(answerGroups, options) {
	for (const answers of answerGroups) {
		const answerShowCorrect = answers.find((a) => matches(a, CORRECT_WORDS));
		const answerShowIncorrect = answers.find((a) => matches(a, INCORRECT_WORDS));

		if (answerShowCorrect || answerShowIncorrect) {
			for (const option of options) {
				const textShowCorrect = matches(option, CORRECT_WORDS);
				const textShowIncorrect = matches(option, INCORRECT_WORDS);

				if (answerShowCorrect && textShowCorrect) {
					return { finish: true, option };
				}
				if (answerShowIncorrect && textShowIncorrect) {
					return { finish: true, option };
				}
			}

			return { finish: false };
		}
	}

	return { finish: false };
}

/** 词表匹配：两侧都做 removeRedundant + clearString（并保留 √ ×），要求归一化后完全相等 */
function matches(target, words) {
	return words.some(
		(word) => clearString(removeRedundant(word), '√', '×') === clearString(removeRedundant(target), '√', '×')
	);
}

/** 检测选项是否为判断题性质（仅有两个选项，且分别为"对"和"错"性质） */
function isJudgementOptions(options) {
	if (options.length !== 2) return false;
	const hasCorrect = options.some((opt) => matches(opt, CORRECT_WORDS));
	const hasIncorrect = options.some((opt) => matches(opt, INCORRECT_WORDS));
	return hasCorrect && hasIncorrect;
}

/* ============================================================================
 * packages/core/src/core/worker/resolvers/completion.ts
 * ==========================================================================*/

/**
 * 填空题匹配算法
 *
 * 遍历题库答案，找到答案数量与填空框数量一致的答案组，
 * 或者填空框只有一个时将所有答案合并。
 *
 * 注意：只要 blankCount === 1 且答案组非空就一定命中（多段答案会被空格 join 成一段）。
 *
 * @param answerGroups  每个题库的答案列表
 * @param blankCount    填空框数量
 * @param separators    答案分隔符
 */
function resolveCompletion(answerGroups, blankCount, separators) {
	for (const answers of answerGroups) {
		let ans = answers.filter((a) => a);
		if (ans.length === 1) {
			ans = splitAnswer(ans[0], separators);
		}

		if (ans.length !== 0 && (ans.length === blankCount || blankCount === 1)) {
			if (ans.length === blankCount) {
				return { finish: true, answers: ans };
			} else if (blankCount === 1) {
				return { finish: true, answers: [ans.join(' ')] };
			}
		}
	}

	return { finish: false };
}

module.exports = {
	// OCS worker/utils.ts
	splitAnswer,
	isPlainAnswer,
	resolvePlainAnswer,
	isProgramAnswer,
	defaultWorkTypeResolver,
	// OCS utils/string.ts
	removeRedundant,
	normalizeString,
	clearString,
	answerNormalizedMatch,
	answerSimilar,
	answerSimilarWithGap,
	answerExactMatch,
	// OCS resolvers
	disambiguateSimilarOptions,
	resolveSingle,
	resolveMultiple,
	resolveJudgement,
	resolveCompletion,
	isJudgementOptions,
	CORRECT_WORDS,
	INCORRECT_WORDS,
	// string-similarity@4.0.4 复刻（OCS 内部使用，一并导出以便验证与复用）
	compareTwoStrings,
	findBestMatch,
	// 其他有用常量/工具
	nowrap,
	DEFAULT_SEPARATORS
};
