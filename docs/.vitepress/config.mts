import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pithagoras",
  description: "A hosted web portal for the pi coding agent",
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-is-pithagoras" },
      { text: "Channels", link: "/channels/" },
      { text: "Reference", link: "/reference/api" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Pithagoras", link: "/guide/what-is-pithagoras" },
          { text: "Deploying", link: "/guide/deploying" },
          { text: "Sessions", link: "/guide/sessions" },
          { text: "Slash commands", link: "/guide/commands" },
          { text: "Settings", link: "/guide/settings" },
          { text: "Extensions", link: "/guide/extensions" },
        ],
      },
      {
        text: "The agent",
        items: [
          { text: "Agent and channels", link: "/channels/" },
          { text: "Writing a channel", link: "/channels/writing-a-channel" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "HTTP API", link: "/reference/api" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Architecture", link: "/reference/architecture" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/thecodacus/Pithagoras" }],

    search: { provider: "local" },

    footer: {
      message: "Give it a task, close the browser, come back later.",
      copyright: "Pithagoras",
    },
  },
});
