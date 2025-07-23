1- First, set up the folder for the location where you want to install the application on your computer.
2- Hold down the Shift key, right-click, and run PowerShell in the current location.
3- Perform the installation from the https://nodejs.org/en/download/ website. You should be able to see the version numbers using the “node -v” and “npm -v” commands in PowerShell. (If you cannot see them, there may be an error in your installation.)
4- To create a file in the current folder location, use the command “npx create-react-app my-app” (my-app will be the name of your project in that location). Then, enter the folder you created using the command “cd my-app” in PowerShell.
5- Run the command “npm install firebase react-icons.”
*1- Enable the “authentication” and “firestore database” features.
*2- At firestore database>rules
"rules_version = ‘2’;

service cloud.firestore {
  match /databases/{database}/documents {

    // This rule allows anyone with your Firestore database reference to view, edit,
    // and delete all data in your Firestore database. It is useful for getting
    // started, but it is configured to expire after 30 days because it
    // leaves your app open to attackers. At that time, all client
    // requests to your Firestore database will be denied.
    //
    // Make sure to write security rules for your app before that time, or else
    // all client requests to your Firestore database will be denied until you Update
    // your rules
    match /{document=**} {
      allow read, write: if request.time < timestamp.date(2025, 8, 22);
    }
  }
}" (current date is 2025, 7, 23). Otherwise, you may encounter problems. 
6- Go to “https://console.firebase.google.com/” and log in. 
7- Create or select your project. Then, on your project's main page, find the “Your apps” section. If your web application is already added, you will see the </> (web) icon. If not, click on the </> icon to add a new web application. Give your app a nickname and do not check the “Set up Firebase Hosting” option for now (we will do this later with the CLI).
8- We created a .env file with the command “New-Item -Path .env -ItemType File.” Select the “alias-named” web application we created in the Firebase project. Copy the colored text immediately below the “Then, initialize Firebase and begin using the SDKs for the products you'd like to use.” section in the “your apps” section of the project settings and paste it into the .env file.
9- Place your own application commands in the “App.js” file located in the ‘src’ directory within the created “my-app” folder.
10- Run the following commands in order: “npm install -g firebase-tools” > “firebase login” > “firebase init”
** Follow these steps when running the firebase init command: 
**1- Press “y” and enter.
**2- Use the up and down arrows to navigate to the firebase and hosting fields, then press the space bar to select them. After selecting both, press enter.
**3- “use an existing project” is the first option, so press enter to move on to the next step.
**4- Select your project and press Enter. 
**5- Press Enter to continue. Finally, you will be asked a yes/no question. Here, select “y” for “Configure as a single-page app (rewrite all urls to /index.html)” and continue.
**6- For “Set up automatic builds and deploys with GitHub?”, press Enter and select “n” since the build and deploy will be done from the computer instead of GitHub.
**7- For “File public/index.html already exists. Overwrite? (y/N)”, press Enter and select “n” to continue.
11- Run the “npx tailwindcss init” command and update the files on GitHub with “tailwind.config.js” & “postcss.config.js”.
12- View your project information with “firebase projects:list”. Select the project with the “firebase use --add” command. Continue by typing “default” for the first question.
13- You can now publish using the “npm run build” and “firebase deploy --only hosting” commands.
*** You can review the application by automatically redirecting to “local:3000” on your computer with the “npm start” command. The application is not published; only how it works locally is observed. This allows you to determine whether the issue is related to the internet, computer, or Firebase.
