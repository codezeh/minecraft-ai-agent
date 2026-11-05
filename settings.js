const settings = {
    "minecraft_version": "1.21.8", // or "auto"
    "host": "127.0.0.1", // local test server
    "port": 25565,
    "auth": "offline", // local server runs in offline mode

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "companion_mode": true,      // 陪玩模式：新原子层（follow/找人）接管对应命令；false 时回退旧实现
    // 用哪个模型配置文件。仓库里只放通用配置（deepseek/claude/gpt/gemini…），
    // 端点走各家官方 API、密钥从 keys.json 读。
    // 私有中转站/自建端点的 profile 请自己放本地，并加进 .gitignore（见 .gitignore 里的说明）。
    // 本地开发用私有配置（中转站/自建端点，已被 gitignore）；
    // 仓库里放的是通用配置 ./profiles/deepseek.json（官方端点）。
    "profiles": [
        "./profiles/my-local.json",
    ],

    "load_memory": true, // load memory from previous session (开启：重启后记得之前发生的事)
    "init_message": "用中文回复 hello world 和你的名字", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language
    "render_bot_view": false, // DISABLED: requires the native `canvas` addon to be built locally

    // 第一轮审查 第1条 ③：**默认关**。打开它等于「本机 root」——不是「受限沙箱」：
    // SES Compartment 挡不住宿主 realm（第1条第三层已实测：注入进去的宿主函数
    // `.constructor('return process')()` 直接拿到宿主 process），而且这条路上还有
    // 蓝图路径越权（第1条第六层）与任务 JSON 注入（第五层）两条**不需要**它的入口。
    // 打开方式：改这里为 true，或 `INSECURE_CODING=1 node main.js`（启动会打印醒目告警）。
    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer (= local root). enable at own risk
    "allow_vision": false, // DISABLED: requires the native `canvas` addon to be built locally
    "blocked_actions" : [], // commands to disable and remove from docs
    "code_timeout_mins": 20, // minutes code is allowed to run. -1 for no timeout -- 给个上限，防止代码死循环；大工程平地需要更长时间
    "relevant_docs_count": 6, // 全量注入的技能文档数量。-1 = 全部
                              // 现在另有「全量目录 + !skillDoc 按需取全文」（见 skill_library.js），
                              // 所以这里只留少量最相关的；原来给 15 + 34 个 always_show，
                              // 每次代码生成要重复付 30k 字符。

    "max_messages": 30, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "none", // "full", "shortened", or "none" -- none: 命令照常执行但不在聊天里显示
    "narrate_behavior": false, // chat simple automatic actions ('Picking up item!') -- 关闭：不污染对话上下文
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 60, // num seconds allowed for the bot to spawn before throwing error
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction

    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
