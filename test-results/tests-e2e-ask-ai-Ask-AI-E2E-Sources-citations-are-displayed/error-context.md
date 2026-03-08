# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - main [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e5]:
          - img "Login Background" [ref=e7]
          - generic [ref=e8]:
            - img [ref=e9]
            - text: Nucleus Platform
          - blockquote [ref=e12]:
            - paragraph [ref=e13]: “Optimize your cloud costs efficiently with our automated scheduling and management platform.”
            - generic [ref=e14]: Nucleus Platform
        - generic [ref=e16]:
          - generic [ref=e17]:
            - heading "Login" [level=1] [ref=e18]
            - paragraph [ref=e19]: Sign in to your account to continue
          - button "Sign in with Cognito" [ref=e21] [cursor=pointer]
          - generic [ref=e22]:
            - text: Need help?
            - link "Contact Support" [ref=e23] [cursor=pointer]:
              - /url: "#"
    - region "Notifications (F8)":
      - list
    - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e29] [cursor=pointer]:
    - img [ref=e30]
  - alert [ref=e33]
```