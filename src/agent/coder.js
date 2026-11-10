import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
// H2：认「这一轮没有可执行代码」信号（见 coder.js:generateCode 里的说明）
import { isNoCodeReply } from '../models/_shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * ★ R6 #12：把「当前操作」折算成模型调用要的取消三件套 `{signal, deadline, operationId}`。
 *
 * 唯一取消源是 `ActionManager._executeAction` 建好并挂到 `agent.currentOperation`
 * 的那个 operation（`{ id, deadline, ac }`）。代码生成跑在 `!newAction` 的动作里，
 * 所以它天然有在飞的操作 —— 但调用点以前只传了消息，`prompter._callOptions({})`
 * 得到 `signal=null`，`!stop` / 动作总超时于是拦不住一次代码生成：模型回来后
 * **代码照样被执行**（审计 R6 #12 的"跳过后果"）。
 *
 * 没有在飞的操作时返回 `{}`：与接线前的缺省逐字一致。
 *
 * @param {{currentOperation?: {id:string, deadline:number|null, ac?:{signal:AbortSignal}|null}|null}} agent
 * @returns {{signal?:AbortSignal|null, deadline?:number|null, operationId?:string}}
 */
function operationCallOpts(agent) {
    const op = agent?.currentOperation ?? null;
    if (!op) return {};
    return {
        signal: op.ac?.signal ?? null,
        deadline: op.deadline ?? null,
        operationId: op.id,
    };
}

/**
 * H2 双保险之二：代码块里**是否真的含有语句**。
 *
 * 为什么需要（这是 H2 的原始复现路径）：旧兜底串 `'```//no response (truncated)```'`
 * 被抽出来的"代码"是 `//no response (truncated)` —— **一行注释**。它执行不报错，
 * 于是被记账成"写了一段代码并成功执行"。所以判据不能是"有没有反引号"，
 * 也不能只依赖上游信号：**剥掉注释与空行后什么都没有 = 没有代码**。
 *
 * @param {string} code 从代码块里抽出的文本
 * @returns {boolean} 含有至少一条语句
 */
function hasStatements(code) {
    const stripped = String(code ?? '')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())  // 行注释
        .join('')
        .trim();
    return stripped.length > 0;
}

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    async generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            // 架构收敛项(1) 步 1：改读**结果类型**，不再在字符串里找暗号。
            //   失败 -> status=error（原来靠「没有反引号」碰巧走对分支）；
            //   截断 -> status=truncated 且 content 已是 NO_CODE 信号（H2 契约，不回退）。
            // ★ R6 #12：第 2 参 opts 把取消信号与动作期限交给 prompter（缺省 `{}`＝旧行为）。
            //   取消回来的是 status=cancelled（failed），下面按"没写代码"处理 —— 返回值的
            //   用法一字未改，只是这一次终于能被停下来了。
            const typed = await this.agent.prompter.promptCodingResult(messages_copy, operationCallOpts(this.agent));
            if (this.agent.bot.interrupt_code)
                return null;
            if (typed.failed) {
                console.warn('[coder] 代码生成失败(' + typed.errorCode + ')：按没写代码处理（不执行任何东西）');
            }
            // 只有内容可用时才交进下面的抽码逻辑；失败一律当空串（与旧路径同语义）
            const res = typed.hasContent ? typed.content : '';
            // ★★★ H2 双保险（第四轮复审，S1「截断假成功」）：
            //   下面 `res.indexOf('```') !== -1` 是**弱判据** —— "回复里有反引号"不等于"模型写了代码"。
            //   缺陷实测：promptCoding 截断时返回的兜底串自带三反引号，于是这里判成有代码、
            //   `substring` 抽出一行 `// no response` 注释当代码执行，跑通后**报成功**
            //   （一次截断 = 一次什么都没做却记账成功的动作）。
            //   所以：**先显式认「没代码」信号**（`[NO_CODE]` 前缀，不含反引号），
            //   认出来就按"没写代码"处理，无论它里面有没有反引号。
            if (isNoCodeReply(res)) {
                console.warn(`No code provided (explicit signal): ${String(res).slice(0, 120)}`);
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system',
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'
                });
                no_code_failures++;
                continue;
            }
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            // ★★★ H2 双保险之二：**只有注释的代码块 = 没有代码**，执行前就拦掉。
            //   原缺陷正是这样复现的：`//no response (truncated)` 被执行、跑通、报成功。
            //   判据不看反引号、也不只依赖上游信号（双保险）—— 剥注释后为空就不碰执行器。
            if (!hasStatements(code)) {
                console.warn('Code block contains no statements (comment-only) — treated as "no code".');
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system',
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'
                });
                no_code_failures++;
                continue;
            }
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /\b((?:skills|world)\.[A-Za-z_$][\w$]*)\s*\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        //
        // ⚠️ 第一轮审查 第 1 条 ④：边界不是这几行，是 `lockdown()`（lockdown.js）真的跑了没有。
        // 注入的是**宿主对象**，所以它们的 `.constructor` 曾经是宿主 `Function`：
        //   `skills.log.constructor('return process.version')()` → `v24.16.0`（= 本机 RCE）
        // 那条路成立的**真原因**是 `lockdown.js` 里有个自引用遮蔽 bug，SES 的 lockdown 其实没执行；
        // 修好之后同样的表达式抛 `TypeError: Function.prototype.constructor is not a valid constructor`。
        // 换句话说：**改这几行注入面没用**（换任何宿主函数都是同一个漏洞），要改的是 lockdown 是否真生效。
        // 仍然别把这里当沙箱：逃逸对抗是持续的活，而 `allow_insecure_coding` 默认 `false` 才是那道总闸。
        const compartment = makeCompartment({
            skills,
            log: skills.log,
            world,
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}