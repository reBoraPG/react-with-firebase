import React, { useState, useEffect, createContext, useContext, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, doc, getDoc, addDoc, setDoc, updateDoc, onSnapshot, collection, query, Timestamp, where, getDocs, writeBatch, orderBy, limit, collectionGroup, deleteDoc } from 'firebase/firestore';
import { FaTasks, FaUserCog, FaCalendarAlt, FaSignOutAlt, FaPlus, FaShoePrints, FaShoppingCart, FaHandHoldingUsd } from 'react-icons/fa';
import { CiDollar } from "react-icons/ci";

// --- FIREBASE CONFIGURATION (Firebase Yapılandırması) ---
// Bu bilgileri projenizin Firebase ayarlarından almalısınız.
const firebaseConfig = {
    apiKey: process.env.REACT_APP_API_KEY,
    authDomain: process.env.REACT_APP_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_PROJECT_ID,
    storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_APP_ID,
};

// --- FIREBASE INITIALIZATION (Firebase Başlatma) ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const appId = firebaseConfig.projectId || 'default-app-id';

// --- HELPER FUNCTIONS ---
const logActivity = async (actor, action, details = {}) => {
    try {
        await addDoc(collection(db, `artifacts/${appId}/public/data/activity_logs`), {
            actor,
            action,
            details,
            timestamp: Timestamp.now(),
        });
    } catch (error) {
        console.error("Aktivite loglama hatası:", error);
    }
};


// --- CONTEXT & HOOKS ---
const FirebaseContext = createContext(null);
const DataContext = createContext(null);
const useFirebase = () => useContext(FirebaseContext);
const useData = () => useContext(DataContext);

// --- PROVIDER COMPONENTS ---
const DataProvider = ({ children }) => {
    const [users, setUsers] = useState([]);
    const [products, setProducts] = useState([]);
    const [customers, setCustomers] = useState([]);
    const [sales, setSales] = useState([]);
    const [practicePayments, setPracticePayments] = useState([]);
    const [customerPayments, setCustomerPayments] = useState([]);
    const [fees, setFees] = useState({ student: 0, standard: 0 });
    const [cashTransfers, setCashTransfers] = useState([]);
    const [ibanTransfers, setIbanTransfers] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const collectionsToFetch = [
            { path: `public/data/products`, setter: setProducts },
            { path: `public/data/customers`, setter: setCustomers },
            { path: `public/data/sales`, setter: setSales, q: query(collection(db, `artifacts/${appId}/public/data/sales`), orderBy("saleDate", "desc")) },
            { path: `public/data/practice_payments`, setter: setPracticePayments },
            { path: `public/data/customer_payments`, setter: setCustomerPayments },
            { path: `public/data/cash_transfers`, setter: setCashTransfers },
            { path: `public/data/iban_to_cash_transfers`, setter: setIbanTransfers },
            { path: `public/data/settings/fees`, setter: setFees, isDoc: true },
        ];

        const unsubs = collectionsToFetch.map(({ path, setter, process, q, isDoc }) => {
            const fullPath = `artifacts/${appId}/${path}`;
            const ref = isDoc ? doc(db, fullPath) : (q || query(collection(db, fullPath)));
            
            return onSnapshot(ref, (snapshot) => {
                if (isDoc) {
                    setter(snapshot.exists() ? snapshot.data() : { student: 0, standard: 0 });
                } else {
                    const data = process ? process(snapshot) : snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    setter(data);
                }
            }, (error) => console.error(`Error fetching ${path}:`, error));
        });

        const usersQuery = collectionGroup(db, 'profile');
        const unsubUsers = onSnapshot(usersQuery, (snapshot) => {
            const usersData = snapshot.docs.map(docSnapshot => {
                const uid = docSnapshot.ref.parent.parent.id;
                return { uid, ...docSnapshot.data() };
            });
            setUsers(usersData);
        }, (error) => console.error("Kullanıcılar çekilirken hata (collectionGroup):", error));

        unsubs.push(unsubUsers);
        
        setLoading(false);
        return () => unsubs.forEach(unsub => unsub());
    }, [db, appId]);

    const customerDebts = useMemo(() => {
        const debtMap = new Map();
        
        const allCustomerNames = new Set([
            ...customers.map(c => c.name), 
            ...sales.map(s => s.customerName), 
            ...practicePayments.map(p => p.attendeeName),
            ...customerPayments.map(cp => cp.customerName)
        ]);

        allCustomerNames.forEach(name => {
            if(name) debtMap.set(name, { sales: 0, practice: 0, paid: 0 });
        });

        sales.forEach(sale => {
            if (debtMap.has(sale.customerName)) {
                debtMap.get(sale.customerName).sales += sale.salePrice;
            }
        });

        practicePayments.forEach(payment => {
            if (debtMap.has(payment.attendeeName)) {
                debtMap.get(payment.attendeeName).practice += payment.amount;
            }
        });

        customerPayments.forEach(payment => {
            if (debtMap.has(payment.customerName)) {
                debtMap.get(payment.customerName).paid += payment.amount;
            }
        });

        const debtList = Array.from(debtMap.entries()).map(([name, data]) => {
            const totalDebt = (data.sales + data.practice) - data.paid;
            return { name, totalDebt };
        }).sort((a,b) => b.totalDebt - a.totalDebt);

        return debtList;
    }, [customers, sales, practicePayments, customerPayments]);

    const allCustomers = useMemo(() => {
        return customers.map(c => ({ id: c.id, name: c.name }));
    }, [customers]);

    const value = { users, products, customers: customers.map(c => c.name).sort(), sales, practicePayments, customerPayments, customerDebts, fees, cashTransfers, ibanTransfers, loading, allCustomers };

    return (
        <DataContext.Provider value={value}>
            {children}
        </DataContext.Provider>
    );
};

const FirebaseProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [userFullName, setUserFullName] = useState('Anonim Kullanıcı');
    const [userRole, setUserRole] = useState('guest');
    const [isAuthReady, setIsAuthReady] = useState(false);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser && !currentUser.isAnonymous) {
                setUser(currentUser);
                const userDocRef = doc(db, `artifacts/${appId}/users/${currentUser.uid}/profile/data`);
                const userDocSnap = await getDoc(userDocRef);
                if (userDocSnap.exists()) {
                    const userData = userDocSnap.data();
                    setUserRole(userData.role || 'sorumlu-2');
                    setUserFullName(userData.name || currentUser.email);
                } else {
                    // Yeni kayıt olan kullanıcılar için varsayılan rol ve isim
                    setUserRole('sorumlu-2');
                    setUserFullName(currentUser.email);
                    // Firestore'a varsayılan profil bilgilerini kaydet
                    await setDoc(userDocRef, { role: 'sorumlu-2', email: currentUser.email, name: currentUser.email.split('@')[0] }, { merge: true });
                }
            } else {
                setUser(null);
                setUserFullName('Anonim Kullanıcı');
                setUserRole('guest');
            }
            setIsAuthReady(true);
        });
        return () => unsubscribe();
    }, [db, appId]); // db ve appId bağımlılıkları eklendi

    const value = { db, auth, user, userFullName, userRole, isAuthReady, appId };

    if (!isAuthReady) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-slate-100">
                <div className="text-lg font-semibold text-gray-700">Yükleniyor...</div>
            </div>
        );
    }

    return (
        <FirebaseContext.Provider value={value}>
            {children}
        </FirebaseContext.Provider>
    );
};

// --- UI COMPONENTS ---
const Card = ({ children, className = "" }) => (
    <div className={`bg-white p-6 rounded-xl shadow-lg transition-shadow hover:shadow-xl ${className}`}>
        {children}
    </div>
);

const CardTitle = ({ children }) => (
    <h2 className="text-3xl font-bold text-slate-800 mb-6 border-b-2 border-slate-200 pb-3">{children}</h2>
);

const Button = ({ onClick, children, className = "bg-indigo-600 hover:bg-indigo-700", type = "button", disabled = false }) => (
    <button
        type={type}
        onClick={onClick}
        disabled={disabled}
        className={`px-6 py-2 text-white font-semibold rounded-lg shadow-md transition-transform transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-slate-400 disabled:cursor-not-allowed disabled:transform-none ${className}`}
    >
        {children}
    </button>
);

const CustomerSelector = ({ selectedCustomer, onCustomerChange, customers, disabled = false }) => {
    const [isAddingNew, setIsAddingNew] = useState(false);
    const [newCustomerName, setNewCustomerName] = useState("");

    const handleSelection = (e) => {
        const value = e.target.value;
        if (value === "---addNew---") {
            setIsAddingNew(true);
            onCustomerChange("");
        } else {
            setIsAddingNew(false);
            onCustomerChange(value);
        }
    };

    const handleNewNameChange = (e) => {
        setNewCustomerName(e.target.value);
        onCustomerChange(e.target.value);
    };

    return (
        <div className="space-y-2">
            <select
                value={isAddingNew ? "---addNew---" : selectedCustomer}
                onChange={handleSelection}
                disabled={disabled}
                className="w-full p-3 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"
            >
                <option value="">Müşteri Seçin...</option>
                {customers.map(name => <option key={name} value={name}>{name}</option>)}
                <option value="---addNew---" className="font-bold text-indigo-600">» Yeni Müşteri Ekle</option>
            </select>
            {isAddingNew && (
                <input
                    type="text"
                    value={newCustomerName}
                    onChange={handleNewNameChange}
                    placeholder="Yeni Müşteri Adı Soyadı"
                    disabled={disabled}
                    className="w-full p-3 border border-indigo-400 rounded-lg focus:ring-2 focus:ring-indigo-500 animate-fade-in disabled:bg-slate-100"
                />
            )}
        </div>
    );
};

// --- AUTHENTICATION ---
const LoginScreen = () => {
    const { auth, db, appId } = useFirebase();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [isRegister, setIsRegister] = useState(false);
    const [error, setError] = useState('');

    const handleAuth = async () => {
        setError('');
        if (!email || !password || (isRegister && !name)) {
            setError('Lütfen tüm alanları doldurun.');
            return;
        }
        try {
            if (isRegister) {
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const userDocRef = doc(db, `artifacts/${appId}/users/${userCredential.user.uid}/profile/data`);
                await setDoc(userDocRef, { role: 'sorumlu-2', email: userCredential.user.email, name: name }); // Yeni kullanıcılar sorumlu-2 olarak başlar
            } else {
                await signInWithEmailAndPassword(auth, email, password);
            }
        } catch (err) {
            setError('İşlem başarısız. Bilgileri kontrol edin veya sonra tekrar deneyin.');
            console.error("Authentication Error:", err);
        }
    };

    return (
        <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 bg-grid-slate-200">
            <div className="w-full max-w-md text-center">
                <h1 className="text-5xl font-bold text-slate-800 mb-3">İşletme Yönetim Paneli</h1>
                <p className="text-slate-600 mb-8 text-lg">Tüm işlerinizi tek bir yerden yönetin.</p>
                <Card>
                    <h3 className="text-2xl font-bold mb-6 text-center text-slate-800">{isRegister ? 'Yeni Hesap Oluştur' : 'Giriş Yap'}</h3>
                    {isRegister && <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Adınız ve Soyadınız" className="w-full p-3 mb-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"/>}
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-posta Adresi" className="w-full p-3 mb-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"/>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Şifre" className="w-full p-3 mb-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"/>
                    {error && <p className="text-red-500 text-sm mb-4 text-center">{error}</p>}
                    <Button onClick={handleAuth} className="w-full py-3 bg-blue-600 hover:bg-blue-700">{isRegister ? 'Kayıt Ol' : 'Giriş Yap'}</Button>
                    <button onClick={() => setIsRegister(!isRegister)} className="w-full mt-4 py-2 text-indigo-600 hover:text-indigo-800 transition-colors">
                        {isRegister ? 'Zaten hesabım var' : 'Hesabım yok, kayıt ol'}
                    </button>
                </Card>
            </div>
        </div>
    );
};


// --- MAIN LAYOUT ---
const DashboardLayout = () => {
    const { userFullName, userRole, auth } = useFirebase();
    const [activeView, setActiveView] = useState('tasks');

    const handleLogout = async () => {
        await signOut(auth);
    };

    const navItems = [
        { id: 'tasks', label: 'Görevler', icon: FaTasks, roles: ['yonetici', 'sorumlu-1', 'sorumlu-2', 'izleyici'] },
        { id: 'attendance', label: 'Devamlılık', icon: FaCalendarAlt, roles: ['yonetici', 'sorumlu-1', 'sorumlu-2', 'izleyici'] },
        { id: 'practice', label: 'Pratik', icon: FaShoePrints, roles: ['yonetici', 'sorumlu-1', 'sorumlu-2', 'izleyici'] },
        // Sorumlu-1 ve İzleyici rolleri için Satışlar ve Ödemeler kaldırıldı
        { id: 'sales', label: 'Satışlar', icon: FaShoppingCart, roles: ['yonetici', 'sorumlu-2'] },
        { id: 'payments', label: 'Ödemeler', icon: FaHandHoldingUsd, roles: ['yonetici', 'sorumlu-2'] },
        { id: 'admin', label: 'Yönetici', icon: FaUserCog, roles: ['yonetici', 'sorumlu-2', 'izleyici'] },
    ];

    return (
        <div className="min-h-screen bg-slate-100 flex flex-col">
            <header className="bg-white shadow-md w-full p-4 flex justify-between items-center z-10">
                <div className="text-2xl font-bold text-indigo-600">İşletmeApp</div>
                <nav className="flex-grow flex justify-center items-center gap-2">
                    {navItems.filter(item => item.roles.includes(userRole)).map(item => (
                        <button
                            key={item.id}
                            onClick={() => setActiveView(item.id)}
                            className={`flex flex-col items-center justify-center gap-1 p-2 rounded-lg transition-all duration-200 w-24 h-20 text-center flex-shrink-0 ${activeView === item.id ? 'bg-indigo-100 text-indigo-700 font-bold scale-105' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
                        >
                            <icon component={item.icon} className="w-6 h-6" />
                            <span className="text-xs font-medium">{item.label}</span>
                        </button>
                    ))}
                </nav>
                <div className="flex items-center gap-4">
                    <div className="text-right">
                        <p className="font-semibold text-slate-800">{userFullName}</p>
                        <p className="text-xs text-slate-500">{userRole}</p>
                    </div>
                    <button onClick={handleLogout} title="Güvenli Çıkış" className="p-2 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors">
                        <icon component={FaSignOutAlt} className="w-10 h-10" />
                    </button>
                </div>
            </header>
            <main className="flex-1 p-4 md:p-8 overflow-y-auto">
                <div className="max-w-7xl mx-auto">
                    {activeView === 'tasks' && <TasksAndAttendance userRole={userRole} />}
                    {activeView === 'attendance' && <AttendanceReport userRole={userRole} />}
                    {activeView === 'practice' && <PracticeFeeTracking userRole={userRole} />}
                    {activeView === 'payments' && <PaymentsDashboard userRole={userRole} />}
                    {activeView === 'sales' && <SalesManagement userRole={userRole} />}
                    {activeView === 'admin' && ['yonetici', 'sorumlu-2', 'izleyici'].includes(userRole) && <AdminPanel userRole={userRole} />}
                </div>
            </main>
        </div>
    );
};

// --- FEATURE COMPONENTS ---

// 1. Görevler ve Yoklama
const TasksAndAttendance = ({ userRole }) => {
    const { db, appId, userFullName, user } = useFirebase();
    const { users } = useData();
    const [tasks, setTasks] = useState([]);
    const [additionalTasks, setAdditionalTasks] = useState([]);
    const [newAdditionalTask, setNewAdditionalTask] = useState('');
    const [attendance, setAttendance] = useState({});
    const today = new Date().toISOString().split('T')[0];
    const [selectedPerformers, setSelectedPerformers] = useState([]); // Çoklu seçim için yeni state
    
    const predefinedTasks = ["WC Temizliği (Kadın)", "WC Temizliği (Erkek)", "Bulaşıklar", "Yerlerin Süpürülmesi", "Çöplerin Atılması", "Ayna ve Cam Silinmesi", "WC peçete-sabun (Kadın)", "WC peçete-sabun (Erkek)", "Diğer İşler"];
    const isReadOnly = userRole === 'izleyici';

    useEffect(() => {
        const qTasks = query(collection(db, `artifacts/${appId}/public/data/tasks`));
        const unsubscribeTasks = onSnapshot(qTasks, (snapshot) => {
            const tasksData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(tasksData);
        }, (error) => console.error(error));

        const qAdditionalTasks = query(collection(db, `artifacts/${appId}/public/data/additional_tasks`), orderBy("createdAt", "desc"));
        const unsubscribeAdditionalTasks = onSnapshot(qAdditionalTasks, (snapshot) => {
            setAdditionalTasks(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => console.error(error));

        const attendanceDocRef = doc(db, `artifacts/${appId}/public/data/attendance/${today}`);
        const unsubAttendance = onSnapshot(attendanceDocRef, (doc) => {
            setAttendance(doc.exists() ? doc.data() : {});
        }, (error) => console.error(error));

        return () => {
            unsubscribeTasks();
            unsubscribeAdditionalTasks();
            unsubAttendance();
        };
    }, [db, appId, today]);

    const handleMarkTaskDone = async (taskDescription) => {
        if (isReadOnly) return;
        const taskRef = doc(db, `artifacts/${appId}/public/data/tasks`, taskDescription);
        try {
            const taskDoc = await getDoc(taskRef);
            let updatedRecentPerformers = taskDoc.exists() && taskDoc.data().recentPerformers ? [...taskDoc.data().recentPerformers] : [];
            updatedRecentPerformers.unshift({ name: userFullName, timestamp: Timestamp.now() });
            updatedRecentPerformers = updatedRecentPerformers.slice(0, 3);
            await setDoc(taskRef, { description: taskDescription, recentPerformers: updatedRecentPerformers }, { merge: true });
            logActivity(userFullName, "Rutin Görev Tamamlama", { task: taskDescription });
        } catch (error) {
            console.error("Görev tamamlama hatası:", error);
        }
    };
    
    const handleSetAttendance = async () => {
        if (isReadOnly) return;
        const attendanceDocRef = doc(db, `artifacts/${appId}/public/data/attendance/${today}`);
        try {
            await setDoc(attendanceDocRef, { [user.uid]: { status: 'geldi', name: userFullName, time: Timestamp.now() } }, { merge: true });
            logActivity(userFullName, "Kendi Yoklamasını İşaretledi");
        } catch(error) {
            console.error("Yoklama işaretleme hatası:", error);
        }
    };

    const handleAddAdditionalTask = async () => {
        if (isReadOnly) return;
        if (!newAdditionalTask.trim()) return;
        try {
            await addDoc(collection(db, `artifacts/${appId}/public/data/additional_tasks`), {
                description: newAdditionalTask,
                isCompleted: false,
                createdAt: Timestamp.now(),
                completedBy: [],
            });
            setNewAdditionalTask('');
            logActivity(userFullName, "Yeni Ek Görev Eklendi", { task: newAdditionalTask });
        } catch (error) {
            console.error("Ek görev ekleme hatası:", error);
        }
    };

    // Ek görev tamamlandığında silme işlemi (Çoklu seçim eklendi)
    const handleCompleteAndRemoveAdditionalTask = async (taskId, currentCompletedBy) => {
        if (isReadOnly) return;
        if (selectedPerformers.length === 0) {
            alert("Lütfen görevi tamamlayan en az bir kullanıcı seçin.");
            return;
        }
        
        const taskRef = doc(db, `artifacts/${appId}/public/data/additional_tasks`, taskId);
        let updatedPerformers = [...currentCompletedBy];

        for (const uid of selectedPerformers) {
            const performerUser = users.find(u => u.uid === uid);
            if (performerUser) {
                // Check if this user is already in the list to avoid duplicates
                const existingIndex = updatedPerformers.findIndex(p => p.name === performerUser.name);
                if (existingIndex > -1) {
                    updatedPerformers.splice(existingIndex, 1); // Remove old entry
                }
                updatedPerformers.unshift({ name: performerUser.name, timestamp: Timestamp.now() });
            }
        }
        updatedPerformers = updatedPerformers.slice(0, 10); // Son 10 tamamlayanı tut

        try {
            // Görevi tamamlandı olarak işaretle ve tamamlayanları güncelle
            await updateDoc(taskRef, { 
                isCompleted: true,
                completedBy: updatedPerformers,
                lastCompletedAt: Timestamp.now()
            });
            logActivity(userFullName, "Ek Görev Tamamlandı ve Silindi", { task_id: taskId, performers: updatedPerformers.map(p => p.name).join(', ') });
            
            // Görevi Firestore'dan sil
            await deleteDoc(taskRef);

            setSelectedPerformers([]); // Seçilen kişileri temizle
        } catch (error) {
            console.error("Ek görev tamamlama veya silme hatası:", error);
            alert("Ek görev tamamlanırken veya silinirken bir hata oluştu.");
        }
    };

    const currentUserAttendance = attendance[user.uid]?.status;

    return (
        <div>
            <CardTitle>Günlük Görevler ve Yoklama</CardTitle>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                    <h3 className="text-xl font-semibold text-slate-700 mb-4">Yapılacak Rutin İşler</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                        {predefinedTasks.map((taskName) => {
                            const taskData = tasks.find(t => t.id === taskName);
                            const recentPerformers = taskData?.recentPerformers || [];
                            return (
                                <Card key={taskName} className="flex flex-col justify-between aspect-square p-4">
                                    <div className="flex-grow">
                                        <p className="text-md font-semibold text-slate-800">{taskName}</p>
                                        {recentPerformers.length > 0 && (
                                            <div className="mt-2 pt-2 border-t text-xs text-slate-500">
                                                <p className="font-bold">Son Yapanlar:</p>
                                                <ul className="list-disc list-inside ml-2">
                                                    {recentPerformers.map((performer, idx) => (
                                                        <li key={idx}>
                                                            {performer.name} ({performer.timestamp.toDate().toLocaleDateString('tr-TR')})
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                    <Button onClick={() => handleMarkTaskDone(taskName)} className="w-full mt-4 !py-1.5 text-sm bg-green-500 hover:bg-green-600" disabled={isReadOnly}>Yaptım</Button>
                                </Card>
                            );
                        })}
                    </div>

                    <h3 className="text-xl font-semibold text-slate-700 mt-8 mb-4">Ek Görevler</h3>
                    <Card className="mb-6">
                        <div className="flex gap-2 mb-4">
                            <input
                                type="text"
                                value={newAdditionalTask}
                                onChange={(e) => setNewAdditionalTask(e.target.value)}
                                placeholder="Yeni ek görev girin..."
                                className="flex-grow p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                disabled={isReadOnly}
                            />
                            <Button onClick={handleAddAdditionalTask} className="!py-2 bg-blue-500 hover:bg-blue-600" disabled={isReadOnly}>Ekle</Button>
                        </div>
                        <h4 className="font-semibold text-slate-700 mb-2">Mevcut Ek Görevler:</h4>
                        <ul className="space-y-2 max-h-60 overflow-y-auto pr-2">
                            {additionalTasks.map((task) => (
                                <li key={task.id} className="p-3 bg-slate-100 rounded-lg text-sm">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="font-semibold">{task.description}</span>
                                        {/* Çoklu seçim için select kutusu */}
                                        <select
                                            multiple // Çoklu seçime izin ver
                                            value={selectedPerformers}
                                            onChange={(e) => {
                                                const options = Array.from(e.target.options);
                                                const selectedValues = options.filter(option => option.selected).map(option => option.value);
                                                setSelectedPerformers(selectedValues);
                                            }}
                                            className="p-2 border rounded-lg bg-white text-sm flex-grow mx-2 h-auto min-h-[40px]" // Yüksekliği ayarla
                                            disabled={isReadOnly}
                                        >
                                            <option value="" disabled>Kimler Yaptı?</option>
                                            {users.filter(u => u && ['yonetici', 'sorumlu-1', 'sorumlu-2'].includes(u.role)).map(user => (
                                                <option key={user.uid} value={user.uid}>{user.name}</option>
                                            ))}
                                        </select>
                                        <Button 
                                            onClick={() => handleCompleteAndRemoveAdditionalTask(task.id, task.completedBy || [])} 
                                            className="!py-1.5 !px-3 text-sm bg-green-500 hover:bg-green-600"
                                            disabled={isReadOnly || selectedPerformers.length === 0} // Seçim yapılmadıysa butonu devre dışı bırak
                                        >
                                            Tamamla
                                        </Button>
                                    </div>
                                    {task.completedBy && task.completedBy.length > 0 && (
                                        <div className="mt-2 pt-2 border-t text-xs text-slate-500">
                                            <p className="font-bold">Son Yapanlar:</p>
                                            <ul className="list-disc list-inside ml-2">
                                                {task.completedBy.map((performer, idx) => (
                                                    <li key={idx}>
                                                        {performer.name} ({performer.timestamp.toDate().toLocaleDateString('tr-TR')} {performer.timestamp.toDate().toLocaleTimeString('tr-TR')})
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </li>
                            ))}
                            {additionalTasks.length === 0 && <p className="text-slate-500 text-center">Henüz ek görev bulunmuyor.</p>}
                        </ul>
                    </Card>
                </div>
                <div>
                    <h3 className="text-xl font-semibold text-slate-700 mb-4">Sorumlu Yoklama ({new Date().toLocaleDateString('tr-TR')})</h3>
                    <Card>
                        {!currentUserAttendance && (
                             <Button onClick={handleSetAttendance} className="w-full mb-4 bg-blue-500 hover:bg-blue-600" disabled={isReadOnly}>Geldim Olarak İşaretle</Button>
                        )}
                        {currentUserAttendance === 'geldi' && (
                            <p className="text-center p-2 rounded-lg bg-green-100 text-green-800 font-semibold mb-4">Bugün 'Geldi' olarak işaretlendiniz.</p>
                        )}
                        <ul className="space-y-2">
                            {users.filter(u => u && ['yonetici', 'sorumlu-1', 'sorumlu-2'].includes(u.role)).map(user => {
                                const userAttendance = attendance[user.uid];
                                return (
                                    <li key={user.uid} className="flex justify-between items-center p-2 bg-slate-50 rounded-lg">
                                        <span className="font-medium text-slate-700">{user.name}</span>
                                        {userAttendance?.status === 'geldi' ? (
                                            <span className="text-xs font-bold px-2 py-1 rounded-full bg-green-200 text-green-800">GELDİ</span>
                                        ) : (
                                            <span className="text-xs font-bold px-2 py-1 rounded-full bg-slate-200 text-slate-600">BEKLENİYOR</span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </Card>
                </div>
            </div>
        </div>
    );
};

// 2. Devamlılık Raporu
const AttendanceReport = ({ userRole }) => {
    const { db, appId } = useFirebase();
    const { users } = useData();
    const [reportData, setReportData] = useState([]);
    const [loading, setLoading] = useState(true);
    const isReadOnly = userRole === 'izleyici'; // İzleyici rolü için salt okunur

    useEffect(() => {
        const fetchReport = async () => {
            if (users.length === 0) {
                setLoading(true);
                return;
            }
            setLoading(true);
            try {
                const eightWeeksAgo = new Date();
                eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
                
                const eightWeeksAgoISO = eightWeeksAgo.toISOString().split('T')[0];

                const responsibleUsers = users.filter(user => user && ['yonetici', 'sorumlu-1', 'sorumlu-2'].includes(user.role));
                
                const attendanceColRef = collection(db, `artifacts/${appId}/public/data/attendance`);
                const q = query(attendanceColRef, where('__name__', '>=', eightWeeksAgoISO));
                const attendanceSnapshot = await getDocs(q);

                const attendanceByUser = {};
                responsibleUsers.forEach(u => {
                    if(u && u.uid) attendanceByUser[u.uid] = { name: u.name, sundays: 0, weekdays: 0 };
                });

                attendanceSnapshot.forEach(doc => {
                    const dateStr = doc.id;
                    const parts = dateStr.split('-').map(part => parseInt(part, 10));
                    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
                    const day = date.getUTCDay(); 
                    const attendees = doc.data();

                    for (const uid in attendees) {
                        if (attendanceByUser[uid] && attendees[uid].status === 'geldi') {
                            if (day === 0) {
                                attendanceByUser[uid].sundays++;
                            } 
                            else if (day >= 1 && day <= 5) { // Pazartesi-Cuma
                                attendanceByUser[uid].weekdays++;
                            }
                        }
                    }
                });

                setReportData(Object.values(attendanceByUser));
            } catch (error) {
                console.error("Rapor oluşturma hatası:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchReport();
    }, [db, appId, users]);

    return (
        <Card>
            <CardTitle>Sorumlu Devamlılık Raporu (Son 8 Hafta)</CardTitle>
            {loading ? <p>Rapor oluşturuluyor...</p> : (
                <div className="overflow-x-auto">
                    <table className="min-w-full bg-white">
                        <thead className="bg-slate-200">
                            <tr>
                                <th className="py-3 px-4 text-left text-sm font-semibold text-slate-700">Sorumlu Adı</th>
                                <th className="py-3 px-4 text-center text-sm font-semibold text-slate-700">Hafta İçi Geldiği Gün Sayısı</th>
                                <th className="py-3 px-4 text-center text-sm font-semibold text-slate-700">Pazar Günü Geldiği Gün Sayısı</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reportData.map(user => (
                                <tr key={user.name} className="border-b hover:bg-slate-50">
                                    <td className="py-3 px-4 font-medium text-slate-800">{user.name}</td>
                                    <td className="py-3 px-4 text-center text-slate-600">{user.weekdays}</td>
                                    <td className="py-3 px-4 text-center text-slate-600">{user.sundays}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
};


// 3. Pratik Ücretleri
const PracticeFeeTracking = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { customers, fees, allCustomers } = useData();
    const [attendeeName, setAttendeeName] = useState('');
    const [feeType, setFeeType] = useState('standard');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [todaysPayments, setTodaysPayments] = useState([]);
    const [error, setError] = useState('');
    const [amountPaid, setAmountPaid] = useState('');
    const isReadOnly = userRole === 'izleyici'; // İzleyici rolü için salt okunur

    useEffect(() => {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        
        const paymentsRef = collection(db, `artifacts/${appId}/public/data/practice_payments`);
        const q = query(paymentsRef, 
            where("createdAt", ">=", Timestamp.fromDate(startOfDay)), 
            where("createdAt", "<=", Timestamp.fromDate(endOfDay)),
            orderBy("createdAt", "asc")
        );
        
        const unsubPayments = onSnapshot(q, snapshot => {
            setTodaysPayments(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => console.error(error));
        
        return () => unsubPayments();
    }, [db, appId, date]);

    const handleAddPayment = async () => {
        if (isReadOnly) return; // İzleyici rolü işlem yapamaz
        setError('');
        const amount = feeType === 'standard' ? fees.standard : fees.student;
        if (!attendeeName || parseFloat(amount) <= 0) {
            alert("Lütfen katılımcı adı girin ve geçerli bir ücret türü seçin."); // TODO: Custom modal ile değiştir
            return;
        }

        try {
            const batch = writeBatch(db);
            let customerDocId = allCustomers.find(c => c.name === attendeeName)?.id;
            if (!customerDocId) {
                const newCustomerRef = doc(collection(db, `artifacts/${appId}/public/data/customers`));
                batch.set(newCustomerRef, { name: attendeeName });
                customerDocId = newCustomerRef.id;
            }

            const paymentRef = doc(collection(db, `artifacts/${appId}/public/data/practice_payments`));
            batch.set(paymentRef, {
                attendeeName,
                amount: parseFloat(amount),
                recordedBy: userFullName,
                createdAt: Timestamp.now(),
            });

            const paidAmountVal = parseFloat(amountPaid);
            if (paidAmountVal > 0) {
                const customerPaymentRef = doc(collection(db, `artifacts/${appId}/public/data/customer_payments`));
                batch.set(customerPaymentRef, {
                    customerName: attendeeName,
                    amount: paidAmountVal,
                    paymentType: 'Nakit',
                    paymentDate: Timestamp.now(),
                    recordedBy: userFullName,
                    paidFor: 'practice',
                    isConfirmed: true 
                });

                // Pratik kasasına ekle
                const practiceCashRef = doc(db, `artifacts/${appId}/public/data/practice_cash/current`);
                const practiceCashDoc = await getDoc(practiceCashRef);
                const currentPracticeCash = practiceCashDoc.exists() ? practiceCashDoc.data().amount : 0;
                batch.set(practiceCashRef, { amount: currentPracticeCash + paidAmountVal }, { merge: true });
            }

            await batch.commit();
            setAttendeeName('');
            setAmountPaid('');
            logActivity(userFullName, "Pratik Ücreti Eklendi", { katılımcı: attendeeName, ücret: amount });
        } catch (err) {
            setError("Ödeme eklenirken bir hata oluştu.");
            console.error(err);
        }
    };

    return (
        <div>
            <CardTitle>Pratik Ücreti Girişi</CardTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <Card>
                    <h3 className="text-xl font-semibold mb-4 text-slate-700">Yeni Katılımcı Ekle</h3>
                    {error && <p className="text-red-500 p-3 bg-red-100 rounded-lg text-center mb-4">{error}</p>}
                    <div className="space-y-4">
                        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500" disabled={isReadOnly} />
                        <CustomerSelector selectedCustomer={attendeeName} onCustomerChange={setAttendeeName} customers={customers} disabled={isReadOnly} />
                        <select value={feeType} onChange={(e) => setFeeType(e.target.value)} className="w-full p-3 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500" disabled={isReadOnly}>
                            <option value="standard">Standart ({fees.standard || 0} TL)</option>
                            <option value="student">Öğrenci ({fees.student || 0} TL)</option>
                        </select>
						<input type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="Peşin Ödeme (Nakit)" className="w-full p-3 border rounded-lg" disabled={isReadOnly}/>
                        <Button onClick={handleAddPayment} className="w-full py-3 bg-emerald-600 hover:bg-emerald-700" disabled={isReadOnly}>Kaydı Ekle</Button>
                    </div>
                </Card>
                <Card>
                    <h3 className="text-xl font-semibold mb-3 text-slate-700">Bugünkü Katılımcılar ({new Date(date).toLocaleDateString('tr-TR')})</h3>
                    <div className="max-h-96 overflow-y-auto pr-2">
                        {todaysPayments.length > 0 ? (
                            <ul className="space-y-2">
                                {todaysPayments.map(p => (
                                    <li key={p.id} className="bg-slate-100 p-3 rounded-lg text-sm flex justify-between items-center">
                                        <span className="font-semibold">{p.attendeeName}: {p.amount.toFixed(2)} TL</span>
                                        <span className="text-slate-500">{p.recordedBy}</span>
                                        <span className="text-xs text-slate-500">{p.createdAt.toDate().toLocaleTimeString('tr-TR')}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-slate-500 mt-4 text-center">Bugün için henüz kayıt girilmedi.</p>
                        )}
                    </div>
                </Card>
            </div>
        </div>
    );
};

// 4. Ödemeler Paneli
const PaymentsDashboard = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { customerDebts, loading } = useData();
    const [message, setMessage] = useState('');
    const [paymentAmount, setPaymentAmount] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState('');
    const [paymentType, setPaymentType] = useState('Nakit');
    const [recentPayments, setRecentPayments] = useState([]);
    const isReadOnly = userRole === 'sorumlu-1' || userRole === 'izleyici'; // Sorumlu-1 ve İzleyici rolleri için salt okunur

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/customer_payments`), orderBy("paymentDate", "desc"), limit(20));
        const unsub = onSnapshot(q, (snapshot) => {
            setRecentPayments(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => console.error("Recent payments fetch error:", error));
        return () => unsub();
    }, [db, appId]);

    const handleAddPayment = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        setMessage('');
        const amount = parseFloat(paymentAmount);
        if (!selectedCustomer || !amount || amount === 0) {
            setMessage('Lütfen bir müşteri ve geçerli bir tutar seçin.');
            return;
        }
        try {
            const batch = writeBatch(db);
            const paymentRef = doc(collection(db, `artifacts/${appId}/public/data/customer_payments`));
            
            batch.set(paymentRef, {
                customerName: selectedCustomer,
                amount: amount,
                paymentType: paymentType,
                paymentDate: Timestamp.now(),
                recordedBy: userFullName,
                isConfirmed: paymentType === 'Nakit' // IBAN için false, Nakit için true
            });

            if (paymentType === 'Nakit') {
                const salesCashRef = doc(db, `artifacts/${appId}/public/data/sales_cash/current`);
                const salesCashDoc = await getDoc(salesCashRef);
                const currentSalesCash = salesCashDoc.exists() ? salesCashDoc.data().amount : 0;
                batch.set(salesCashRef, { amount: currentSalesCash + amount }, { merge: true });
            } 
            // IBAN kasasına ekleme artık sadece onaylama fonksiyonunda yapılacak
            // else if (paymentType === 'IBAN') { ... } // Bu kısım kaldırıldı

            await batch.commit();
            setMessage(`${selectedCustomer} için ${amount} TL ödeme başarıyla kaydedildi.`);
            setSelectedCustomer('');
            setPaymentAmount('');
            logActivity(userFullName, "Müşteri Ödemesi Kaydı", { customer: selectedCustomer, amount: amount, type: paymentType });
        } catch (error) {
            console.error("Ödeme ekleme hatası:", error);
            setMessage("Ödeme eklenirken bir hata oluştu.");
        }
    };

    const handleResetDebt = async (customerName, totalDebt) => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        if (Math.abs(totalDebt) < 0.01) {
            setMessage("Müşterinin borcu zaten sıfır.");
            return;
        }

        if (!window.confirm(`${customerName} adlı müşterinin ${totalDebt.toFixed(2)} TL tutarındaki bakiyesini sıfırlamak için bir düzeltme kaydı oluşturmak istediğinizden emin misiniz? Bu işlem müşterinin geçmiş aktivitelerini SİLMEZ.`)) {
            return;
        }

        const adjustmentAmount = -totalDebt;

        try {
            await addDoc(collection(db, `artifacts/${appId}/public/data/customer_payments`), {
                customerName: customerName,
                amount: adjustmentAmount,
                paymentType: 'Bakiye Düzeltme',
                paymentDate: Timestamp.now(),
                recordedBy: userFullName,
                isConfirmed: true,
                paidFor: 'Düzeltme'
            });
            setMessage(`${customerName} adlı müşterinin bakiyesi başarıyla sıfırlandı.`);
            logActivity(userFullName, "Müşteri Bakiye Sıfırlama", { customer: customerName, adjustmentAmount: adjustmentAmount });
        } catch (error) {
            console.error("Müşteri bakiye sıfırlama hatası:", error);
            setMessage("Müşteri bakiyesi sıfırlanırken bir hata oluştu.");
        }
    };

    if (loading) return <p>Borç durumu hesaplanıyor...</p>;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card>
                <h3 className="text-xl font-semibold mb-4 text-slate-700">Borç Ödemesi Al / Ödeme Yap</h3>
                {message && <p className={`p-3 rounded-lg text-center mb-4 ${message.includes('başarıyla') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{message}</p>}
                <div className="space-y-4">
                    <select value={selectedCustomer} onChange={e => setSelectedCustomer(e.target.value)} className="w-full p-3 border rounded-lg bg-white" disabled={isReadOnly}>
                        <option value="">Müşteri Seçin...</option>
                        {customerDebts.map(c => <option key={c.name} value={c.name}>{c.name} ({c.totalDebt.toFixed(2)} TL)</option>)}
                    </select>
                    <input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} placeholder="Ödeme Tutarı (TL) (Pozitif: Aldım, Negatif: Verdim)" className="w-full p-3 border rounded-lg" disabled={isReadOnly} />
                    <select value={paymentType} onChange={e => setPaymentType(e.target.value)} className="w-full p-3 border rounded-lg bg-white" disabled={isReadOnly}>
                        <option value="Nakit">Nakit</option>
                        <option value="IBAN">IBAN</option>
                    </select>
                    <Button onClick={handleAddPayment} className="w-full py-3 bg-emerald-600 hover:bg-emerald-700" disabled={isReadOnly}>Ödemeyi Kaydet</Button>
                </div>
            </Card>
            <div>
                <Card>
                    <h3 className="text-xl font-semibold mb-4 text-slate-700">Müşteri Borç/Alacak Durumu</h3>
                    {customerDebts.length === 0 ? <p className="text-slate-500">Müşteri borç/alacak durumu yok.</p> : (
                        <ul className="space-y-2 max-h-96 overflow-y-auto">
                            {customerDebts.map(debt => (
                                <li key={debt.name} className={`flex justify-between items-center p-3 rounded-lg ${debt.totalDebt > 0 ? 'bg-red-50' : debt.totalDebt < 0 ? 'bg-green-50' : 'bg-slate-50'}`}>
                                    <span className="font-medium text-slate-800">{debt.name}</span>
                                    <span className={`font-bold ${debt.totalDebt > 0 ? 'text-red-600' : debt.totalDebt < 0 ? 'text-green-600' : 'text-slate-600'}`}>
                                        {debt.totalDebt.toFixed(2)} TL
                                    </span>
                                    {Math.abs(debt.totalDebt) >= 0.01 && (
                                        <Button onClick={() => handleResetDebt(debt.name, debt.totalDebt)} className="!py-1 !px-2 text-xs bg-orange-500 hover:bg-orange-600" disabled={isReadOnly}>Bakiyeyi Sıfırla</Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
                <Card className="mt-8">
                    <h3 className="text-xl font-semibold mb-3 text-slate-700">Son 20 Ödeme Hareketi</h3>
                    <ul className="space-y-2 max-h-96 overflow-y-auto pr-2">
                        {recentPayments.length > 0 ? (
                            recentPayments.map(p => (
                                <li key={p.id} className="bg-slate-100 p-3 rounded-lg text-sm flex justify-between items-center">
                                    <div>
                                        <p><span className="font-semibold">{p.customerName}</span>: <span className="font-bold text-indigo-600">{p.amount.toFixed(2)} TL</span> ({p.paymentType})</p>
                                        <p className="text-xs text-slate-500">Kaydeden: {p.recordedBy} - {p.paymentDate.toDate().toLocaleString('tr-TR')}</p>
                                    </div>
                                </li>
                            ))
                        ) : (
                            <p className="text-slate-500 mt-4 text-center">Henüz ödeme hareketi bulunmuyor.</p>
                        )}
                    </ul>
                </Card>
            </div>
        </div>
    );
};

// 5. Satış Yönetimi
const SalesManagement = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { products, customers, sales, allCustomers } = useData();
    const [productName, setProductName] = useState('');
    const [customerName, setCustomerName] = useState('');
    const [salePrice, setSalePrice] = useState('');
    const [amountPaid, setAmountPaid] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const isReadOnly = userRole === 'sorumlu-1' || userRole === 'izleyici'; // Sorumlu-1 ve İzleyici rolleri için salt okunur

    useEffect(() => {
        if (productName) {
            const selectedProduct = products.find(p => p.name === productName);
            if (selectedProduct) setSalePrice(selectedProduct.price);
        } else {
            setSalePrice('');
        }
    }, [productName, products]);

    const handleAddSale = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        setError('');
        setMessage('');
        if (!productName || !customerName || !salePrice || parseFloat(salePrice) <= 0) {
            setError("Lütfen ürün, müşteri ve satış fiyatı alanlarını doldurun.");
            return;
        }

        try {
            const batch = writeBatch(db);
            let customerDocId = allCustomers.find(c => c.name === customerName)?.id;
            if (!customerDocId) {
                const newCustomerRef = doc(collection(db, `artifacts/${appId}/public/data/customers`));
                batch.set(newCustomerRef, { name: customerName });
                customerDocId = newCustomerRef.id;
            }

            const saleRef = doc(collection(db, `artifacts/${appId}/public/data/sales`));
            batch.set(saleRef, {
                productName, customerName, salePrice: parseFloat(salePrice),
                saleDate: Timestamp.now(), recordedBy: userFullName
            });

            const paidAmount = parseFloat(amountPaid);
            if (paidAmount > 0) {
                const paymentRef = doc(collection(db, `artifacts/${appId}/public/data/customer_payments`));
                batch.set(paymentRef, {
                    customerName,
                    amount: paidAmount,
                    paymentType: 'Nakit',
                    paymentDate: Timestamp.now(),
                    recordedBy: userFullName,
                    paidFor: 'sales',
                    isConfirmed: true
                });

                // Satış kasasına ekle
                const salesCashRef = doc(db, `artifacts/${appId}/public/data/sales_cash/current`);
                const salesCashDoc = await getDoc(salesCashRef);
                const currentSalesCash = salesCashDoc.exists() ? salesCashDoc.data().amount : 0;
                batch.set(salesCashRef, { amount: currentSalesCash + paidAmount }, { merge: true });
            }

            await batch.commit();
            setMessage(`'${customerName}' adına '${productName}' satışı başarıyla eklendi.`);
            setProductName(''); setCustomerName(''); setSalePrice(''); setAmountPaid('');
            logActivity(userFullName, "Satış Eklendi", { ürün: productName, müşteri: customerName, fiyat: salePrice });
        } catch (err) {
            setError("Satış eklenirken bir hata oluştu.");
            console.error(err);
        }
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
                <CardTitle>Satış Girişi</CardTitle>
                <Card>
                    {isReadOnly && <div className="p-3 mb-4 text-center bg-yellow-100 text-yellow-800 rounded-lg">Bu panel sizin için salt okunurdur.</div>}
                    {error && <p className="text-red-500 p-3 bg-red-100 rounded-lg text-center mb-4">{error}</p>}
                    {message && <p className="text-green-500 p-3 bg-green-100 rounded-lg text-center mb-4">{message}</p>}
                    <div className="space-y-4">
                        <CustomerSelector selectedCustomer={customerName} onCustomerChange={setCustomerName} customers={customers} disabled={isReadOnly} />
                        <select value={productName} onChange={(e) => setProductName(e.target.value)} disabled={isReadOnly} className="w-full p-3 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100">
                            <option value="">Ürün Seçin</option>
                            {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                        </select>
                        <input type="number" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} disabled={isReadOnly} placeholder="Satış Fiyatı (TL)" className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"/>
                        <input type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="Peşin Ödeme (Nakit)" className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"/>
                    </div>
                    <Button onClick={handleAddSale} disabled={isReadOnly} className="w-full mt-6 py-3 bg-emerald-600 hover:bg-emerald-700">Satışı Ekle</Button>
                </Card>
            </div>
            <div>
                <h2 className="text-2xl font-bold text-slate-800 mb-6">Son 50 Satış</h2>
                <Card className="max-h-[600px] overflow-y-auto">
                    <ul className="space-y-3">
                        {sales.map(sale => (
                            <li key={sale.id} className="p-3 bg-slate-50 rounded-lg text-sm">
                                <div className="flex justify-between items-center">
                                    <span className="font-semibold">{sale.customerName}, {sale.productName}</span>
                                    <span className="font-bold text-indigo-600">{sale.salePrice.toFixed(2)} TL</span>
                                </div>
                                <div className="flex justify-between items-center text-xs text-slate-500 mt-1">
                                    <span>{sale.recordedBy}</span>
                                    <span>{sale.saleDate.toDate().toLocaleDateString()}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </Card>
            </div>
        </div>
    );
};

// 6. Yönetici Paneli
const AdminPanel = ({ userRole }) => {
    // Sorumlu-2 rolü için Ürün ve Fiyat Yönetimi hariç tümü salt okunur
    const isReadOnlyForSorumlu2 = userRole === 'sorumlu-2';
    const isReadOnlyForIzleyici = userRole === 'izleyici';

    return (
        <div>
            <CardTitle>Yönetici Paneli</CardTitle>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-8">
                    <FinancialSummary userRole={userRole} />
					<IbanConfirmation userRole={userRole}/>
                    <FeeManagement userRole={userRole} />
                    {/* Ürün ve Fiyat Yönetimi Sorumlu-2 için düzenlenebilir olacak */}
                    <ProductManagement userRole={userRole} /> 
                </div>
                <div className="space-y-8">
                     <UserRoleManagement userRole={userRole} />
                     <RecentTasksList userRole={userRole} />
					 <UserRegistration userRole={userRole} />
					 <ActivityLog userRole={userRole} />
                </div>
            </div>
        </div>
    );
};

// Yönetici Paneli Alt Bileşenleri
const FinancialSummary = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { customerDebts, loading: debtsLoading } = useData();
    const [salesCash, setSalesCash] = useState(0);
    const [practiceCash, setPracticeCash] = useState(0);
    const [ibanCash, setIbanCash] = useState(0);
    const [mainCash, setMainCash] = useState(0);

    const [salesTransferAmount, setSalesTransferAmount] = useState(0);
    const [practiceTransferAmount, setPracticeTransferAmount] = useState(0);
    const [ibanTransferAmount, setIbanTransferAmount] = useState(0);

    const isReadOnly = userRole === 'sorumlu-2' || userRole === 'izleyici'; // Sorumlu-2 ve İzleyici rolleri için salt okunur

    useEffect(() => {
        const unsubMain = onSnapshot(doc(db, `artifacts/${appId}/public/data/main_cash/current`), (snap) => {
            setMainCash(snap.exists() ? snap.data().amount : 0);
        });
        const unsubSales = onSnapshot(doc(db, `artifacts/${appId}/public/data/sales_cash/current`), (snap) => {
            setSalesCash(snap.exists() ? snap.data().amount : 0);
        });
        const unsubPractice = onSnapshot(doc(db, `artifacts/${appId}/public/data/practice_cash/current`), (snap) => {
            setPracticeCash(snap.exists() ? snap.data().amount : 0);
        });
        const unsubIban = onSnapshot(doc(db, `artifacts/${appId}/public/data/iban_cash/current`), (snap) => {
            setIbanCash(snap.exists() ? snap.data().amount : 0);
        });
        return () => { unsubMain(); unsubSales(); unsubPractice(); unsubIban(); };
    }, [db, appId]);

    const handleTransferToMain = async (sourceCashType, amountToTransfer) => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        if (amountToTransfer <= 0) return;

        const mainCashRef = doc(db, `artifacts/${appId}/public/data/main_cash/current`);
        let sourceCashRef;
        let currentSourceAmount;

        if (sourceCashType === 'sales') {
            sourceCashRef = doc(db, `artifacts/${appId}/public/data/sales_cash/current`);
            currentSourceAmount = salesCash;
        } else if (sourceCashType === 'practice') {
            sourceCashRef = doc(db, `artifacts/${appId}/public/data/practice_cash/current`);
            currentSourceAmount = practiceCash;
        } else if (sourceCashType === 'iban') {
            sourceCashRef = doc(db, `artifacts/${appId}/public/data/iban_cash/current`);
            currentSourceAmount = ibanCash;
        } else {
            console.error("Geçersiz kasa tipi:", sourceCashType);
            return;
        }

        if (amountToTransfer > currentSourceAmount) {
            alert(`Transfer edilecek miktar, ${sourceCashType} kasasındaki mevcut miktardan fazla olamaz.`); // TODO: Custom modal ile değiştir
            return;
        }

        const batch = writeBatch(db);
        batch.set(mainCashRef, { amount: mainCash + amountToTransfer }, { merge: true });
        batch.set(sourceCashRef, { amount: currentSourceAmount - amountToTransfer }, { merge: true });

        try {
            await batch.commit();
            logActivity(userFullName, `${sourceCashType.charAt(0).toUpperCase() + sourceCashType.slice(1)} Kasasından Ana Kasaya Aktarım`, { miktar: amountToTransfer });
            if (sourceCashType === 'sales') setSalesTransferAmount(0);
            else if (sourceCashType === 'practice') setPracticeTransferAmount(0);
            else if (sourceCashType === 'iban') setIbanTransferAmount(0);

        } catch (error) {
            console.error("Aktarım hatası:", error);
            alert("Aktarım sırasında bir hata oluştu."); // TODO: Custom modal ile değiştir
        }
    };

    const resetMainCash = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        if (window.confirm("Ana kasayı sıfırlamak istediğinizden emin misiniz? Bu işlem geri alınamaz.")) { // TODO: Custom modal ile değiştir
            const mainCashRef = doc(db, `artifacts/${appId}/public/data/main_cash/current`);
            try {
                await setDoc(mainCashRef, { amount: 0 });
                logActivity(userFullName, "Ana Kasa Sıfırlama", { eski_deger: mainCash });
            } catch (error) {
                console.error("Ana kasa sıfırlama hatası:", error);
            }
        }
    };

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-4 text-slate-700">Finansal Özet</h3>
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-orange-50 p-3 rounded-lg text-center">
                    <p className="font-semibold text-orange-800 text-sm">Satış Kasası (Nakit)</p>
                    <p className="text-xl font-bold text-orange-600">{salesCash.toFixed(2)} TL</p>
                    <input type="number" value={salesTransferAmount} onChange={e => setSalesTransferAmount(parseFloat(e.target.value) || 0)} placeholder="Aktarılacak Tutar" className="w-full p-2 border rounded-lg mt-2" disabled={isReadOnly} />
                    <Button onClick={() => handleTransferToMain('sales', salesTransferAmount)} className="!text-xs !py-1 !px-2 mt-2 bg-indigo-500 hover:bg-indigo-600" disabled={isReadOnly}>Ana Kasaya Aktar</Button>
                </div>
                <div className="bg-sky-50 p-3 rounded-lg text-center">
                    <p className="font-semibold text-sky-800 text-sm">Pratik Kasası (Nakit)</p>
                    <p className="text-xl font-bold text-sky-600">{practiceCash.toFixed(2)} TL</p>
                    <input type="number" value={practiceTransferAmount} onChange={e => setPracticeTransferAmount(parseFloat(e.target.value) || 0)} placeholder="Aktarılacak Tutar" className="w-full p-2 border rounded-lg mt-2" disabled={isReadOnly} />
                    <Button onClick={() => handleTransferToMain('practice', practiceTransferAmount)} className="!text-xs !py-1 !px-2 mt-2 bg-indigo-500 hover:bg-indigo-600" disabled={isReadOnly}>Ana Kasaya Aktar</Button>
                </div>
                 <div className="bg-cyan-50 p-3 rounded-lg text-center">
                    <p className="font-semibold text-cyan-800 text-sm">IBAN Kasası (Onaylı)</p>
                    <p className="text-xl font-bold text-cyan-600">{ibanCash.toFixed(2)} TL</p>
                    <input type="number" value={ibanTransferAmount} onChange={e => setIbanTransferAmount(parseFloat(e.target.value) || 0)} placeholder="Aktarılacak Tutar" className="w-full p-2 border rounded-lg mt-2" disabled={isReadOnly} />
                    <Button onClick={() => handleTransferToMain('iban', ibanTransferAmount)} className="!text-xs !py-1 !px-2 mt-2 bg-indigo-500 hover:bg-indigo-600" disabled={isReadOnly}>Ana Kasaya Aktar</Button>
                </div>
                <div className="bg-blue-50 p-3 rounded-lg text-center">
                    <p className="font-semibold text-blue-800 text-sm">Ana Kasa</p>
                    <p className="text-xl font-bold text-blue-600">{mainCash.toFixed(2)} TL</p>
                    <Button onClick={resetMainCash} className="!text-xs !py-1 !px-2 mt-2 bg-red-500 hover:bg-red-600" disabled={isReadOnly}>Sıfırla</Button>
                </div>
            </div>
        </Card>
    );
};

const IbanConfirmation = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const [pendingPayments, setPendingPayments] = useState([]);
    const isReadOnly = userRole === 'sorumlu-2' || userRole === 'izleyici'; // Sorumlu-2 ve İzleyici rolleri için salt okunur

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/customer_payments`), where("paymentType", "==", "IBAN"), where("isConfirmed", "==", false));
        const unsub = onSnapshot(q, (snap) => setPendingPayments(snap.docs.map(d => ({id: d.id, ...d.data()}))));
        return () => unsub();
    }, [db, appId]);

    const handleConfirm = async (payment) => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        const batch = writeBatch(db);
        const paymentRef = doc(db, `artifacts/${appId}/public/data/customer_payments`, payment.id);
        batch.update(paymentRef, { isConfirmed: true });

        const ibanCashRef = doc(db, `artifacts/${appId}/public/data/iban_cash/current`);
        const ibanCashDoc = await getDoc(ibanCashRef);
        const currentIbanCash = ibanCashDoc.exists() ? ibanCashDoc.data().amount : 0;
        // IBAN kasasına ödeme miktarını ekle (sadece onaylandığında)
        batch.set(ibanCashRef, { amount: currentIbanCash + payment.amount }, { merge: true });

        try {
            await batch.commit();
            await logActivity(userFullName, "IBAN Ödeme Onayı", { müşteri: payment.customerName, miktar: payment.amount });
        } catch (error) {
            console.error("IBAN onaylama hatası:", error);
            alert("IBAN ödemesi onaylanırken bir hata oluştu."); // TODO: Custom modal ile değiştir
        }
    };

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">IBAN Ödeme Onayları</h3>
            <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {pendingPayments.length > 0 ? pendingPayments.map(p => (
                    <div key={p.id} className="p-3 bg-yellow-50 rounded-lg flex justify-between items-center">
                        <div>
                            <p className="font-semibold text-yellow-800">{p.customerName} - {p.amount.toFixed(2)} TL</p>
                            <p className="text-xs text-yellow-600">{p.paymentDate.toDate().toLocaleDateString()}</p>
                        </div>
                        <Button onClick={() => handleConfirm(p)} className="!py-1 !px-3 text-sm bg-green-500 hover:bg-green-600" disabled={isReadOnly}>Onayla</Button>
                    </div>
                )) : <p className="text-slate-500">Onay bekleyen IBAN ödemesi yok.</p>}
            </div>
        </Card>
    );
};

const ActivityLog = ({ userRole }) => {
    const { db, appId } = useFirebase();
    const [logs, setLogs] = useState([]);
    const isReadOnly = userRole === 'izleyici'; // İzleyici rolü için salt okunur

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/activity_logs`), orderBy("timestamp", "desc"), limit(20));
        const unsub = onSnapshot(q, (snap) => setLogs(snap.docs.map(d => ({id: d.id, ...d.data()}))));
        return () => unsub();
    }, [db, appId]);

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Güncellemeler (Son 20 Olay)</h3>
            <ul className="space-y-2 max-h-96 overflow-y-auto pr-2 text-sm">
                {logs.map(log => (
                    <li key={log.id} className="p-2 bg-slate-50 rounded-lg">
                        <p><span className="font-semibold">{log.actor}</span>: {log.action}</p>
                        {log.details && Object.keys(log.details).length > 0 && 
                            <p className="text-xs text-slate-500 pl-2 border-l-2 ml-2">
                                {Object.entries(log.details).map(([key, value]) => `${key}: ${value}`).join(', ')}
                            </p>
                        }
                        <p className="text-xs text-slate-400 text-right">{log.timestamp.toDate().toLocaleString()}</p>
                    </li>
                ))}
            </ul>
        </Card>
    );
};

const RecentTasksList = ({ userRole }) => {
    const { db, appId } = useFirebase();
    const [recentTasks, setRecentTasks] = useState([]);
    const isReadOnly = userRole === 'izleyici'; // İzleyici rolü için salt okunur

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/tasks`));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const allPerformers = snapshot.docs.flatMap(doc => {
                const taskData = doc.data();
                return taskData.recentPerformers ? taskData.recentPerformers.map(p => ({
                    ...p,
                    task: taskData.description
                })) : [];
            });
            allPerformers.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());
            setRecentTasks(allPerformers.slice(0, 10));
        }, (error) => console.error(error));
        return () => unsubscribe();
    }, [db, appId]);

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Son Yapılan İşler</h3>
            <ul className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {recentTasks.map((task, index) => (
                    <li key={index} className="p-3 bg-slate-100 rounded-lg text-sm">
                        <div className="flex justify-between items-center">
                            <span className="font-semibold">{task.task}</span>
                            <span className="text-xs text-slate-500">{task.timestamp.toDate().toLocaleString()}</span>
                        </div>
                        <p className="text-slate-600 mt-1">Yapan: {task.name}</p>
                    </li>
                ))}
            </ul>
        </Card>
    );
};

const FeeManagement = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { fees } = useData();
    const [localFees, setLocalFees] = useState(fees);
    const [message, setMessage] = useState('');
    const isReadOnly = userRole === 'sorumlu-2' || userRole === 'izleyici'; // Sorumlu-2 ve İzleyici rolleri için salt okunur

    useEffect(() => {
        setLocalFees(fees);
    }, [fees]);

    const handleUpdateFees = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        try {
            await setDoc(doc(db, `artifacts/${appId}/public/data/settings/fees`), {
                standard: parseFloat(localFees.standard) || 0,
                student: parseFloat(localFees.student) || 0,
            });
			await logActivity(userFullName, "Pratik Ücretleri Güncelleme", { standard: localFees.standard, student: localFees.student });
            setMessage('Ücretler başarıyla güncellendi!');
            setTimeout(() => setMessage(''), 3000);
        } catch (error) {
            console.error("Ücret güncelleme hatası:", error);
            setMessage('Ücretler güncellenirken bir hata oluştu.');
            setTimeout(() => setMessage(''), 3000);
        }
    };

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Pratik Ücret Yönetimi</h3>
            {message && <p className="text-green-500 p-2 bg-green-100 rounded-lg text-center mb-4">{message}</p>}
            <div className="space-y-3">
                <input type="number" value={localFees.standard} onChange={(e) => setLocalFees({...localFees, standard: e.target.value})} placeholder="Standart Ücret (TL)" className="w-full p-3 border rounded-lg" disabled={isReadOnly}/>
                <input type="number" value={localFees.student} onChange={(e) => setLocalFees({...localFees, student: e.target.value})} placeholder="Öğrenci Ücreti (TL)" className="w-full p-3 border rounded-lg" disabled={isReadOnly}/>
            </div>
            <Button onClick={handleUpdateFees} className="w-full mt-4 !py-2 bg-emerald-600 hover:bg-emerald-700" disabled={isReadOnly}>Güncelle</Button>
        </Card>
    );
};

const ProductManagement = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { products } = useData();
    const [newProductName, setNewProductName] = useState('');
    const [newProductPrice, setNewProductPrice] = useState('');
    // Sorumlu-2 ve İzleyici rolleri için salt okunur DEĞİL, sadece Yönetici için düzenlenebilir
    const isReadOnly = userRole === 'izleyici'; 
    
    const handleAddProduct = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        if (!newProductName || !newProductPrice) return;
        await addDoc(collection(db, `artifacts/${appId}/public/data/products`), {
            name: newProductName,
            price: parseFloat(newProductPrice)
        });
		await logActivity(userFullName, "Yeni Ürün Ekleme", { product: newProductName, price: newProductPrice });
        setNewProductName(''); setNewProductPrice('');
    };
    
    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Ürün ve Fiyat Yönetimi</h3>
            <div className="flex gap-3 mb-4 items-end">
                <input type="text" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} placeholder="Yeni Ürün Adı" className="flex-grow p-3 border rounded-lg" disabled={isReadOnly}/>
                <input type="number" value={newProductPrice} onChange={(e) => setNewProductPrice(e.target.value)} placeholder="Fiyat (TL)" className="w-32 p-3 border rounded-lg" disabled={isReadOnly}/>
                <Button onClick={handleAddProduct} className="!px-5 !py-3 bg-emerald-600 hover:bg-emerald-700" disabled={isReadOnly}><FaPlus /></Button>
            </div>
            <ul className="space-y-2 max-h-48 overflow-y-auto pr-2">{products.map(p => (
                <li key={p.id} className="p-3 bg-slate-100 rounded-lg flex justify-between">
                    <span>{p.name}</span>
                    <span className="font-semibold">{p.price.toFixed(2)} TL</span>
                </li>))}
            </ul>
        </Card>
    );
};

const UserRoleManagement = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const { users } = useData();
    const isReadOnly = userRole === 'sorumlu-2' || userRole === 'izleyici'; // Sorumlu-2 ve İzleyici rolleri için salt okunur
    
    const handleUpdateUserRole = async (uid, role) => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        await updateDoc(doc(db, `artifacts/${appId}/users/${uid}/profile/data`), { role });
		await logActivity(userFullName, "Kullanıcı Rol Güncelleme", { user: users.find(u => u.uid === uid)?.email, newRole: role });
    };

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Kullanıcı Rol Yönetimi</h3>
            <ul className="space-y-2 max-h-60 overflow-y-auto pr-2">{users.filter(u => u.email).map(u => (
                <li key={u.uid} className="flex flex-col md:flex-row justify-between items-center p-3 bg-slate-100 rounded-lg">
                    <div className="text-sm text-slate-800 text-center md:text-left">
                        <p className="font-semibold">{u.name}</p>
                        <p className="text-xs text-slate-500">{u.email}</p>
                    </div>
                    <select value={u.role} onChange={(e) => handleUpdateUserRole(u.uid, e.target.value)} className="p-2 border rounded-lg bg-white mt-2 md:mt-0" disabled={isReadOnly}>
                        <option value="yonetici">Yönetici</option>
                        <option value="sorumlu-1">Sorumlu-1</option>
                        <option value="sorumlu-2">Sorumlu-2</option>
						<option value="izleyici">izleyici</option>
                    </select>
					
                </li>))}
            </ul>
        </Card>
    );
	
};

const UserRegistration = ({ userRole }) => {
    const { db, appId, userFullName } = useFirebase();
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [role, setRole] = useState('izleyici'); // Varsayılan rol izleyici olarak ayarlandı
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const isReadOnly = userRole === 'sorumlu-2' || userRole === 'izleyici'; // Sorumlu-2 ve İzleyici rolleri için salt okunur

    const handleRegister = async () => {
        if (isReadOnly) return; // Salt okunur ise işlem yapma
        setMessage(''); setError('');
        if (!email || !name || !role || !password) { setError("Tüm alanlar zorunludur."); return; }
        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            await setDoc(doc(db, `artifacts/${appId}/users/${userCredential.user.uid}/profile/data`), { name, email, role });
            await logActivity(userFullName, "Yeni Kullanıcı Kaydı", { kaydedilen_kullanıcı: email, rol: role });
            setMessage(`${name} adlı kullanıcı başarıyla kaydedildi.`);
            setEmail(''); setName(''); setRole('izleyici'); setPassword('');
        } catch (err) { setError("Kullanıcı kaydı başarısız oldu: " + err.message); }
    };

    return (
        <Card>
            <h3 className="text-xl font-semibold mb-3 text-slate-700">Yeni Kullanıcı Kaydı</h3>
            {message && <p className="p-2 text-center text-green-800 bg-green-100 rounded-lg">{message}</p>}
            {error && <p className="p-2 text-center text-red-800 bg-red-100 rounded-lg">{error}</p>}
            <div className="space-y-3 mt-4">
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="E-posta" className="w-full p-3 border rounded-lg" disabled={isReadOnly} />
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="İsim Soyisim" className="w-full p-3 border rounded-lg" disabled={isReadOnly} />
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Geçici Şifre" className="w-full p-3 border rounded-lg" disabled={isReadOnly} />
                <select value={role} onChange={e => setRole(e.target.value)} className="w-full p-3 border rounded-lg bg-white" disabled={isReadOnly}>
                    <option value="yonetici">Yönetici</option>
                    <option value="sorumlu-1">Sorumlu-1</option>
                    <option value="sorumlu-2">Sorumlu-2</option>
                    <option value="izleyici">İzleyici</option>
                </select>
            </div>
            <Button onClick={handleRegister} className="w-full mt-4 !py-2 bg-emerald-600 hover:bg-emerald-700" disabled={isReadOnly}>Kullanıcıyı Kaydet</Button>
        </Card>
    );
};

// --- APP ENTRY POINT ---
const App = () => (
    <FirebaseProvider>
        <DataProvider>
            <MainAppContent />
        </DataProvider>
    </FirebaseProvider>
);

const MainAppContent = () => {
    const { user, isAuthReady } = useFirebase();
    if (!isAuthReady) {
        return <div className="flex items-center justify-center min-h-screen bg-gray-100">Yükleniyor...</div>;
    }
    if (!user) return <LoginScreen />;
    return <DashboardLayout />;
};

export default App;
