import settings from './settings.js';
import { containsCommand } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';

/**
 * ★ R6 #12：把「当前在飞操作」折算成模型层可用的取消信号。
 *
 * 与 history.js / coder.js / vision_interpreter.js 里的同名函数**逐字一致**——
 * 刻意重复而不是抽公共模块：这三处都在 agent 热路径上，抽出去会新增一层
 * import 关系，而仓里的「前缀 import 规矩」与本文件的依赖方向都不希望如此。
 * 若将来要合并成一份，请三处一起改，别只改一处。
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

let agent;
let agent_names = [];
let agents_in_game = [];

class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
    }

    reset() {
        this.active = false;
        this.ignore_until_start = false;
        this.in_queue = [];
        this.inMessageTimer = null;
    }

    end() {
        this.active = false;
        this.ignore_until_start = true;
        this.inMessageTimer = null;
        const full_message = _compileInMessages(this);
        if (full_message.message.trim().length > 0)
            agent.history.add(this.name, full_message.message);
        // add the full queued messages to history, but don't respond

        if (agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

const WAIT_TIME_START = 30000;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
    }

    initAgent(a) {
        agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`, null, { internal: true });
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`, null, { internal: true });
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        const convo = this._getConvo(send_to);
        convo.reset();
        
        if (agent.self_prompter.isActive()) {
            await agent.self_prompter.pause();
        }
        if (convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, false);
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);
        
        if (settings.chat_bot_messages && open_chat)
            agent.openChat(`(To ${send_to}) ${message}`);
        
        if (convo.ignore_until_start)
            return;
        convo.active = true;
        
        const end = message.includes('!endConversation');
        const json = {
            'message': message,
            start,
            end,
        };

        this.awaiting_response = true;
        sendBotChatToServer(send_to, json);
    }

    async receiveFromBot(sender, received) {
        const convo = this._getConvo(sender);

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }

        this._clearMonitorTimeouts();
        convo.queue(received);
        
        // responding to conversation takes priority over self prompting
        if (agent.self_prompter.isActive()){
            await agent.self_prompter.pause();
        }
    
        // ★ T32：本方法是 async 的、`_scheduleProcessInMessage` 也是 async 的 →
        //   **真的该 await**（"排定什么时候回复"就是这一步的语义），不是 fire-and-forget。
        await _scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }
    
    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }
    
    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }
    
    endConversation(sender) {
        if (this.convos[sender]) {
            this.convos[sender].end();
            if (this.activeConversation.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
                if (agent.self_prompter.isPaused() && !this.inConversation()) {
                    // ★ T32：`_resumeSelfPrompter` 先 sleep 5000ms 再恢复自提示 ——
                    //   设计上就是"晚点再说"，**不能 await**（会把 endConversation 卡 5 秒）。
                    //   但必须显式接住 rejection：漏了就是 unhandled rejection，
                    //   而且一旦发生自提示**再也恢复不了**（静默）。
                    _resumeSelfPrompter().catch((e) => {
                        console.warn(`[convo] 恢复自提示失败：${String(e?.message ?? e)}`);
                    });
                }
            }
        }
    }
    
    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (agent.self_prompter.isPaused()) {
            // ★ 同上（T32）：不 await（会卡 5 秒），但必须接住 rejection
            _resumeSelfPrompter().catch((e) => {
                console.warn(`[convo] 恢复自提示失败：${String(e?.message ?? e)}`);
            });
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

/*
This function controls conversation flow by deciding when the bot responds.
The logic is as follows:
- If neither bot is busy, respond quickly with a small delay.
- If only the other bot is busy, respond with a long delay to allow it to finish short actions (ex check inventory)
- If I'm busy but other bot isn't, let LLM decide whether to respond
- If both bots are busy, don't respond until someone is done, excluding a few actions that allow fast responses
- New messages received during the delay will reset the delay following this logic, and be queued to respond in bulk
*/
const talkOverActions = ['stay', 'followPlayer', 'mode:']; // all mode actions
const fastDelay = 200;
const longDelay = 5000;
async function _scheduleProcessInMessage(sender, received, convo) {
    if (convo.inMessageTimer)
        clearTimeout(convo.inMessageTimer);
    let otherAgentBusy = containsCommand(received.message);

    const scheduleResponse = (delay) => convo.inMessageTimer = setTimeout(() => _processInMessageQueue(sender), delay);

    if (!agent.isIdle() && otherAgentBusy) {
        // both are busy
        let canTalkOver = talkOverActions.some(a => agent.actions.currentActionLabel.includes(a));
        if (canTalkOver)
            scheduleResponse(fastDelay)
        // otherwise don't respond
    }
    else if (otherAgentBusy)
        // other bot is busy but I'm not
        scheduleResponse(longDelay);
    else if (!agent.isIdle()) {
        // I'm busy but other bot isn't
        let canTalkOver = talkOverActions.some(a => agent.actions.currentActionLabel.includes(a));
        if (canTalkOver) {
            scheduleResponse(fastDelay);
        }
        else {
            // ★ R6 #12（2026-11-10）：补上最后一个未接点。
            //   t3 修了记忆摘要/代码生成/看图五个出口，但这里（"忙的时候要不要插话"）
            //   同样是一次模型调用，同样拿不到取消信号 ⇒ !stop 之后仍会跑满。
            let shouldRespond = await agent.prompter.promptShouldRespondToBot(received.message, operationCallOpts(agent));
            console.log(`${agent.name} decided to ${shouldRespond?'respond':'not respond'} to ${sender}`);
            if (shouldRespond)
                scheduleResponse(fastDelay);
        }
    }
    else {
        // neither are busy
        scheduleResponse(fastDelay);
    }
}

function _processInMessageQueue(name) {
    const convo = convoManager._getConvo(name);
    _handleFullInMessage(name, _compileInMessages(convo));
}

function _compileInMessages(convo) {
    let pack = {};
    let full_message = '';
    while (convo.in_queue.length > 0) {
        pack = convo.in_queue.shift();
        full_message += pack.message;
    }
    pack.message = full_message;
    return pack;
}

function _handleFullInMessage(sender, received) {
    console.log(`${agent.name} responding to "${received.message}" from ${sender}`);
    
    const convo = convoManager._getConvo(sender);
    convo.active = true;

    let message = _tagMessage(received.message);
    // BOT-001：这里 sender 被换成 'system' 后，必须由**代码**声明 internal，
    // 不能再指望"名字叫 system 就算内部"（玩家可以叫 system）。
    let from_system = false;
    if (received.end) {
        convoManager.endConversation(sender);
        message = `Conversation with ${sender} ended with message: "${message}"`;
        sender = 'system'; // bot will respond to system instead of the other bot
        from_system = true;
    }
    else if (received.start)
        agent.shut_up = false;
    convo.inMessageTimer = null;
    agent.handleMessage(sender, message, null, from_system ? { internal: true } : {});
}


function _tagMessage(message) {
    return "(FROM OTHER BOT)" + message;
}

async function _resumeSelfPrompter() {
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (agent.self_prompter.isPaused() && !convoManager.inConversation()) {
        agent.self_prompter.start();
    }
}
