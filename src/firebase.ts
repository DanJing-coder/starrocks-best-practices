import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCf3KLmorzcsqeCYdtFIuyY4ZBT-5yE-ZA",
  authDomain: "docs-sr.firebaseapp.com",
  projectId: "docs-sr",
  storageBucket: "docs-sr.firebasestorage.app",
  messagingSenderId: "837260088136",
  appId: "1:837260088136:web:bacb9771cac7b23b86597d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

